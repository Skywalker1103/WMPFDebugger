import { promises as fs } from "node:fs";
import path from "node:path";
import WebSocket from "ws";

type CdpResult = {
    result?: {
        type?: string;
        subtype?: string;
        value?: unknown;
        description?: string;
    };
    exceptionDetails?: {
        text?: string;
        lineNumber?: number;
        columnNumber?: number;
        exception?: {
            description?: string;
            value?: unknown;
        };
    };
};

type CdpResponse = {
    id?: number;
    method?: string;
    params?: unknown;
    result?: CdpResult;
    error?: {
        code: number;
        message: string;
    };
};

type CdpRuntimeConsoleEvent = {
    type?: string;
    executionContextId?: number;
    args?: Array<{ value?: unknown; description?: string; type?: string }>;
};

type CdpRuntimeExceptionEvent = {
    exceptionDetails?: {
        text?: string;
        exception?: { description?: string; value?: unknown };
        executionContextId?: number;
    };
};

type ExecutionContextDescription = {
    id: number;
    name: string;
    origin: string;
    auxData?: {
        isDefault?: boolean;
        type?: string;
        frameId?: string;
    };
};

const printUsage = () => {
    console.log("Usage:");
    console.log('  npx ts-node src/eval.ts --port 62003 --expr "wx.getSystemInfoSync()"');
    console.log("  npx ts-node src/eval.ts --port 62003 --file inject.js");
    console.log("Optional:");
    console.log("  --host 127.0.0.1");
    console.log("  --timeout 10000");
    console.log("  --follow");
    console.log("  --follow-all-contexts");
    console.log("  --file inject.js");
    console.log("  --context-id 7");
    console.log('  --context-name "mainContext"');
    console.log('  --context-query "mainContext"');
    console.log("  --list-contexts");
};

const parseArgs = (argv: string[]) => {
    let host = "127.0.0.1";
    let port: number | null = null;
    let expr: string | null = null;
    let scriptFile: string | null = null;
    let timeoutMs = 10000;
    let follow = false;
    let followAllContexts = false;
    let contextId: number | null = null;
    let contextName: string | null = null;
    let contextQuery: string | null = null;
    let listContexts = false;

    for (let i = 0; i < argv.length; i++) {
        const current = argv[i];
        const next = argv[i + 1];

        if (current === "--host" && next) {
            host = next;
            i++;
            continue;
        }
        if (current === "--port" && next) {
            port = Number(next);
            i++;
            continue;
        }
        if (current === "--expr" && next) {
            expr = next;
            i++;
            continue;
        }
        if (current === "--file" && next) {
            scriptFile = next;
            i++;
            continue;
        }
        if (current === "--timeout" && next) {
            timeoutMs = Number(next);
            i++;
            continue;
        }
        if (current === "--follow") {
            follow = true;
            continue;
        }
        if (current === "--follow-all-contexts") {
            followAllContexts = true;
            follow = true;
            continue;
        }
        if (current === "--context-id" && next) {
            contextId = Number(next);
            i++;
            continue;
        }
        if (current === "--context-name" && next) {
            contextName = next;
            i++;
            continue;
        }
        if (current === "--context-query" && next) {
            contextQuery = next;
            i++;
            continue;
        }
        if (current === "--list-contexts") {
            listContexts = true;
            continue;
        }
        if (current === "-h" || current === "--help") {
            printUsage();
            process.exit(0);
        }
    }

    if (!port || Number.isNaN(port)) {
        throw new Error("Missing or invalid --port");
    }
    if (!listContexts && !expr && !scriptFile) {
        scriptFile = "src/inject.js";
    }
    if (!timeoutMs || Number.isNaN(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Missing or invalid --timeout");
    }

    if (contextId !== null && (Number.isNaN(contextId) || contextId < 1)) {
        throw new Error("Missing or invalid --context-id");
    }
    if (contextId !== null && contextName) {
        throw new Error("Use either --context-id or --context-name, not both");
    }
    if (contextId !== null && contextQuery) {
        throw new Error("Use either --context-id or --context-query, not both");
    }
    if (contextName && contextQuery) {
        throw new Error("Use either --context-name or --context-query, not both");
    }

    return { host, port, expr, scriptFile, timeoutMs, follow, followAllContexts, contextId, contextName, contextQuery, listContexts };
};

const runEval = async () => {
    const { host, port, expr, scriptFile, timeoutMs, follow, followAllContexts, contextId, contextName, contextQuery, listContexts } = parseArgs(process.argv.slice(2));
    let scriptContent: string | null = expr;
    if (!listContexts && !scriptContent) {
        const fullPath = path.resolve(process.cwd(), scriptFile ?? "inject.js");
        scriptContent = await fs.readFile(fullPath, "utf8");
        console.log(`[eval] loaded script file: ${fullPath}`);
    }
    if (!listContexts && !scriptContent) {
        throw new Error("No script content to evaluate");
    }
    const wsUrl = `ws://${host}:${port}`;
    const ws = new WebSocket(wsUrl);

    let nextId = 1;
    let finished = false;
    let runtimeEnabled = false;
    let runtimeEnableRequestId = -1;
    let logEnableRequestId = -1;
    let evaluateRequestId = -1;
    let evaluateSent = false;
    let activeContextId: number | undefined;
    const contexts = new Map<number, ExecutionContextDescription>();

    const timeout = setTimeout(() => {
        if (finished) {
            return;
        }
        finished = true;
        if (contextName) {
            console.error(`[eval] timeout after ${timeoutMs}ms (context-name not found: ${contextName})`);
        } else if (contextQuery) {
            console.error(`[eval] timeout after ${timeoutMs}ms (context-query not found: ${contextQuery})`);
        } else {
            console.error(`[eval] timeout after ${timeoutMs}ms`);
        }
        ws.close();
        process.exit(1);
    }, timeoutMs);

    const printContextsAndExit = () => {
        const all = [...contexts.values()].sort((a, b) => a.id - b.id);
        if (all.length === 0) {
            console.log("[eval] no execution contexts received");
        } else {
            console.log("[eval] execution contexts:");
            for (const ctx of all) {
                const type = ctx.auxData?.type ?? "unknown";
                const isDefault = ctx.auxData?.isDefault ? "default" : "non-default";
                console.log(`- id=${ctx.id} name=${ctx.name || "(empty)"} type=${type} ${isDefault} origin=${ctx.origin}`);
            }
        }
        finished = true;
        clearTimeout(timeout);
        ws.close();
        process.exit(0);
    };

    const maybeSendEvaluate = () => {
        if (!runtimeEnabled || evaluateSent || listContexts) {
            return;
        }

        let selectedContextId: number | undefined;
        let selectedContext: ExecutionContextDescription | undefined;
        if (contextId !== null) {
            selectedContextId = contextId;
            selectedContext = contexts.get(contextId);
        } else if (contextName) {
            const found = [...contexts.values()].find(ctx => ctx.name === contextName);
            if (!found) {
                return;
            }
            selectedContextId = found.id;
            selectedContext = found;
        } else if (contextQuery) {
            const keyword = contextQuery.toLowerCase();
            const found = [...contexts.values()].find(ctx =>
                (ctx.name || "").toLowerCase().includes(keyword) ||
                (ctx.origin || "").toLowerCase().includes(keyword)
            );
            if (!found) {
                return;
            }
            selectedContextId = found.id;
            selectedContext = found;
        }

        evaluateSent = true;
        evaluateRequestId = nextId++;
        activeContextId = selectedContextId;
        if (selectedContextId !== undefined) {
            const selectedName = selectedContext?.name || "(empty)";
            const selectedOrigin = selectedContext?.origin || "(empty)";
            console.log(`[eval] using context id=${selectedContextId} name=${selectedName} origin=${selectedOrigin}`);
        } else {
            console.log("[eval] using default execution context");
        }
        const evaluatePayload = {
            id: evaluateRequestId,
            method: "Runtime.evaluate",
            params: {
                expression: scriptContent,
                includeCommandLineAPI: true,
                returnByValue: true,
                awaitPromise: true,
                contextId: selectedContextId
            }
        };
        ws.send(JSON.stringify(evaluatePayload));
    };

    ws.on("open", () => {
        runtimeEnableRequestId = nextId++;
        const enablePayload = {
            id: runtimeEnableRequestId,
            method: "Runtime.enable"
        };
        ws.send(JSON.stringify(enablePayload));
        logEnableRequestId = nextId++;
        ws.send(JSON.stringify({ id: logEnableRequestId, method: "Log.enable" }));
    });

    ws.on("message", (data: WebSocket.RawData) => {
        if (finished) {
            return;
        }

        let parsed: CdpResponse;
        try {
            parsed = JSON.parse(data.toString()) as CdpResponse;
        } catch (e) {
            console.error("[eval] failed to parse response:", e);
            return;
        }

        if (parsed.method === "Runtime.executionContextsCleared") {
            contexts.clear();
            return;
        }
        if (parsed.method === "Runtime.consoleAPICalled") {
            const evt = parsed.params as CdpRuntimeConsoleEvent | undefined;
            if (!followAllContexts && activeContextId !== undefined && evt?.executionContextId !== activeContextId) {
                return;
            }
            const parts = (evt?.args ?? []).map(arg => {
                if (arg.value !== undefined) {
                    return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
                }
                if (arg.description) {
                    return arg.description;
                }
                return arg.type ?? "unknown";
            });
            const ctxInfo = evt?.executionContextId !== undefined ? ` ctx=${evt.executionContextId}` : "";
            console.log(`[console${ctxInfo}] ${parts.join(" ")}`);
            return;
        }
        if (parsed.method === "Runtime.exceptionThrown") {
            const evt = parsed.params as CdpRuntimeExceptionEvent | undefined;
            const details = evt?.exceptionDetails;
            if (!followAllContexts && activeContextId !== undefined && details?.executionContextId !== activeContextId) {
                return;
            }
            const msg = details?.exception?.description || details?.text || "unknown exception";
            const ctxInfo = details?.executionContextId !== undefined ? ` ctx=${details.executionContextId}` : "";
            console.error(`[runtime-exception${ctxInfo}] ${msg}`);
            return;
        }
        if (parsed.method === "Runtime.executionContextCreated") {
            const ctx = (parsed.params as { context?: ExecutionContextDescription } | undefined)?.context;
            if (ctx && typeof ctx.id === "number") {
                contexts.set(ctx.id, ctx);
            }
            maybeSendEvaluate();
            return;
        }

        if (parsed.error) {
            finished = true;
            clearTimeout(timeout);
            console.error(`[eval] CDP error ${parsed.error.code}: ${parsed.error.message}`);
            ws.close();
            process.exit(1);
            return;
        }

        if (!runtimeEnabled && parsed.id === runtimeEnableRequestId) {
            runtimeEnabled = true;
            if (listContexts) {
                setTimeout(() => {
                    if (!finished) {
                        printContextsAndExit();
                    }
                }, 300);
                return;
            }
            maybeSendEvaluate();
            return;
        }

        if (parsed.id !== evaluateRequestId) {
            return;
        }

        const evalResult = parsed.result;
        if (!evalResult) {
            console.log("[eval] no result");
            if (!follow) {
                finished = true;
                clearTimeout(timeout);
                ws.close();
                process.exit(0);
            }
            return;
        }

        if (evalResult.exceptionDetails) {
            const details = evalResult.exceptionDetails;
            const line = (details.lineNumber ?? 0) + 1;
            const col = (details.columnNumber ?? 0) + 1;
            console.error(`[eval] exception at ${line}:${col}`);
            if (details.text) {
                console.error(`[eval] ${details.text}`);
            }
            if (details.exception?.description) {
                console.error(details.exception.description);
            } else if (details.exception?.value !== undefined) {
                console.error(details.exception.value);
            }
            finished = true;
            clearTimeout(timeout);
            ws.close();
            process.exit(2);
            return;
        }

        const payload = evalResult.result;
        if (!payload) {
            console.log("[eval] evaluate succeeded with empty payload");
            process.exit(0);
            return;
        }

        if (payload.value !== undefined) {
            if (typeof payload.value === "string") {
                console.log(payload.value);
            } else {
                console.log(JSON.stringify(payload.value, null, 2));
            }
            if (follow) {
                clearTimeout(timeout);
                console.log("[eval] follow mode enabled, waiting for runtime logs...");
                return;
            }
            finished = true;
            clearTimeout(timeout);
            ws.close();
            process.exit(0);
            return;
        }

        if (payload.description) {
            console.log(payload.description);
            if (follow) {
                clearTimeout(timeout);
                console.log("[eval] follow mode enabled, waiting for runtime logs...");
                return;
            }
            finished = true;
            clearTimeout(timeout);
            ws.close();
            process.exit(0);
            return;
        }

        console.log(`[eval] type=${payload.type ?? "unknown"} subtype=${payload.subtype ?? "unknown"}`);
        if (follow) {
            clearTimeout(timeout);
            console.log("[eval] follow mode enabled, waiting for runtime logs...");
            return;
        }
        finished = true;
        clearTimeout(timeout);
        ws.close();
        process.exit(0);
    });

    ws.on("error", (err) => {
        if (finished) {
            return;
        }
        finished = true;
        clearTimeout(timeout);
        console.error("[eval] websocket error:", err.message);
        process.exit(1);
    });

    ws.on("close", () => {
        if (finished) {
            return;
        }
        finished = true;
        clearTimeout(timeout);
        console.error("[eval] websocket closed before evaluate response");
        process.exit(1);
    });
};

(async () => {
    try {
        await runEval();
    } catch (e) {
        console.error("[eval]", (e as Error).message);
        printUsage();
        process.exit(1);
    }
})();
