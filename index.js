import express from "express";
import { webFetch } from "./tools/web.js";
import { runCode } from "./tools/code.js";
import { generateImage } from "./tools/image.js";

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const body = req.body;
  const requests = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const request of requests) {
    const { method, params, id } = request;

    try {
      if (method === "initialize") {
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "execution-engine", version: "1.0.0" }
          }
        });
        continue;
      }

      if (method === "notifications/initialized") continue;

      if (method === "tools/list" || method === "list_tools") {
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "web_fetch",
                description: "Fetch website content",
                inputSchema: {
                  type: "object",
                  properties: { url: { type: "string" } },
                  required: ["url"]
                }
              },
              {
                name: "run_code",
                description: "Execute JavaScript code",
                inputSchema: {
                  type: "object",
                  properties: {
                    language: { type: "string" },
                    code: { type: "string" }
                  },
                  required: ["language", "code"]
                }
              },
              {
                name: "generate_image",
                description: "Generate AI image",
                inputSchema: {
                  type: "object",
                  properties: { prompt: { type: "string" } },
                  required: ["prompt"]
                }
              }
            ]
          }
        });
        continue;
      }

      if (method === "tools/call" || method === "call_tool") {
        let result;
        switch (params.name) {
          case "web_fetch":
            result = await webFetch(params.arguments.url);
            break;
          case "run_code":
            result = await runCode(params.arguments.language, params.arguments.code);
            break;
          case "generate_image":
            result = await generateImage(params.arguments.prompt);
            break;
          default:
            throw new Error("Tool not found");
        }
        responses.push({ jsonrpc: "2.0", id, result });
        continue;
      }

      if (method === "ping") {
        responses.push({ jsonrpc: "2.0", id, result: {} });
        continue;
      }

      responses.push({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });

    } catch (err) {
      responses.push({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message }
      });
    }
  }

  const finalResponse = Array.isArray(body) ? responses : responses[0];
  if (finalResponse) res.json(finalResponse);
  else res.status(200).send();
});

app.get("/", (req, res) => res.send("✅ Execution Server Running"));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Execution Server Running (port ${port})`));