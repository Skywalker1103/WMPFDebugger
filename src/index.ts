import { promises } from "node:fs";
import path from "node:path";
import * as frida from "frida";
import WebSocket, { WebSocketServer } from "ws";

const codex = require("./third-party/RemoteDebugCodex.js");
const messageProto = require("./third-party/WARemoteDebugProtobuf.js");

// default debugging port, do not change
const DEBUG_PORT = 9421;
// CDP port range [62000, 62018]
const CDP_PORT_START = 62000;
const CDP_PORT_END = 62018;
// debug switch
const DEBUG = false;

type SlotState = {
    index: number;
    port: number;
    wss: WebSocketServer;
    miniappWs: WebSocket | null;
    messageCounter: number;
};

const slots: SlotState[] = [];
const miniappToSlot = new Map<WebSocket, SlotState>();

const bufferToHexString = (buffer: ArrayBuffer) => {
    return Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, "0")).join("");
};

const createProxySlots = () => {
    for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
        const slotIndex = port - CDP_PORT_START;
        const wss = new WebSocketServer({ port });
        const slot: SlotState = {
            index: slotIndex,
            port,
            wss,
            miniappWs: null,
            messageCounter: 0
        };
        slots.push(slot);

        wss.on("connection", (ws: WebSocket) => {
            console.log(`[conn] CDP client connected on port ${slot.port} (slot ${slot.index})`);

            ws.on("message", (message: string) => {
                if (!slot.miniappWs || slot.miniappWs.readyState !== WebSocket.OPEN) {
                    DEBUG && console.warn(`[proxy] no miniapp bound for slot ${slot.index}, dropping CDP message`);
                    return;
                }

                const rawPayload = {
                    jscontext_id: "",
                    op_id: Math.round(100 * Math.random()),
                    payload: message.toString()
                };
                const wrappedData = codex.wrapDebugMessageData(rawPayload, "chromeDevtools", 0);
                const outData = {
                    seq: ++slot.messageCounter,
                    category: "chromeDevtools",
                    data: wrappedData.buffer,
                    compressAlgo: 0,
                    originalSize: wrappedData.originalSize
                };
                const encodedData = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.encode(outData).finish();
                slot.miniappWs.send(encodedData, { binary: true });
            });

            ws.on("error", (err) => {
                console.error(`[client] CDP err on port ${slot.port}:`, err);
            });
            ws.on("close", () => {
                console.log(`[client] CDP client disconnected from port ${slot.port}`);
            });
        });

        console.log(`[server] proxy server running on ws://localhost:${port} (slot ${slotIndex})`);
    }
};

const findFreeSlot = () => {
    return slots.find(slot => slot.miniappWs === null) || null;
};

const releaseSlot = (slot: SlotState) => {
    slot.miniappWs = null;
    slot.messageCounter = 0;

    slot.wss.clients.forEach(client => {
        try {
            client.close(1012, "miniapp disconnected");
        } catch (e) {
            DEBUG && console.error(`[proxy] close CDP client failed on slot ${slot.index}:`, e);
        }
    });

    console.log(`[slot] released slot ${slot.index}, port ${slot.port}`);
};

const debug_server = () => {
    const wss = new WebSocketServer({ port: DEBUG_PORT });
    console.log(`[server] debug server running on ws://localhost:${DEBUG_PORT}`);

    wss.on("connection", (ws: WebSocket) => {
        const slot = findFreeSlot();
        if (!slot) {
            console.error("[conn] no free proxy slot available, rejecting miniapp client");
            ws.close(1013, "no free proxy slot");
            return;
        }

        slot.miniappWs = ws;
        miniappToSlot.set(ws, slot);
        console.log(`[conn] miniapp client connected, assigned to slot ${slot.index}, port ${slot.port}`);

        ws.on("message", (message: ArrayBuffer) => {
            DEBUG && console.log(`[client] received raw message (hex): ${bufferToHexString(message)}`);

            let unwrappedData: any = null;
            try {
                const decodedData = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.decode(message);
                unwrappedData = codex.unwrapDebugMessageData(decodedData);
                // DEBUG && console.log("[client] [DEBUG] decoded data:");
                // DEBUG && console.dir(unwrappedData);
            } catch (e) {
                console.error(`[client] err: ${e}`);
                return;
            }

            if (unwrappedData === null || unwrappedData.category !== "chromeDevtoolsResult") {
                return;
            }

            slot.wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(unwrappedData.data.payload);
                }
            });
        });

        ws.on("error", (err) => {
            console.error("[client] miniapp err:", err);
        });

        ws.on("close", () => {
            console.log(`[client] miniapp client disconnected from slot ${slot.index}`);
            miniappToSlot.delete(ws);
            releaseSlot(slot);
        });
    });
};

const frida_server = async () => {
    const localDevice = await frida.getLocalDevice();
    const processes = await localDevice.enumerateProcesses({ scope: frida.Scope.Metadata });
    const wmpfProcesses = processes.filter(process => process.name === "WeChatAppEx.exe");
    const wmpfPids = wmpfProcesses.map(p => p.parameters.ppid ? p.parameters.ppid : 0);

    // find the parent process
    const wmpfPid = wmpfPids.sort((a, b) => wmpfPids.filter(v => v === a).length - wmpfPids.filter(v => v === b).length).pop();
    if (wmpfPid === undefined) {
        throw new Error("[frida] WeChatAppEx.exe process not found");
    }
    const wmpfProcess = processes.filter(process => process.pid === wmpfPid)[0];
    const wmpfProcessPath = wmpfProcess.parameters.path as string | undefined;
    const wmpfVersionMatch = wmpfProcessPath ? wmpfProcessPath.match(/\d+/g) : "";
    const wmpfVersion = wmpfVersionMatch ? new Number(wmpfVersionMatch.pop()) : 0;
    if (wmpfVersion === 0) {
        throw new Error("[frida] error in find wmpf version");
    }

    // attach to process
    const session = await localDevice.attach(Number(wmpfPid));

    // find hook script
    const projectRoot = path.join(path.dirname(require.main && require.main.filename || process.mainModule && process.mainModule.filename || process.cwd()), "..");
    let scriptContent: string | null = null;
    try {
        scriptContent = (await promises.readFile(path.join(projectRoot, "frida/hook.js"))).toString();
    } catch (e) {
        throw new Error("[frida] hook script not found");
    }

    let configContent: string | null = null;
    try {
        configContent = (await promises.readFile(path.join(projectRoot, "frida/config", `addresses.${wmpfVersion}.json`))).toString();
        configContent = JSON.stringify(JSON.parse(configContent));
    } catch (e) {
        throw new Error(`[frida] version config not found: ${wmpfVersion}`);
    }

    if (scriptContent === null || configContent === null) {
        throw new Error("[frida] unable to find hook script");
    }

    // load script
    const script = await session.createScript(scriptContent.replace("@@CONFIG@@", configContent));
    script.message.connect(message => {
        console.log("[frida client]", message);
    });
    await script.load();
    console.log(`[frida] script loaded, WMPF version: ${wmpfVersion}, pid: ${wmpfPid}`);
};

const main = async () => {
    createProxySlots();
    debug_server();
    await frida_server();
};

(async () => {
    await main();
})();
