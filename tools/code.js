import { exec } from "child_process";

export function runCode(language, code) {
  if (language !== "javascript") {
    return { content: [{ type: "text", text: "Only JS supported." }] };
  }
  return new Promise((resolve) => {
    exec(`node -e "${code.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
      resolve({ content: [{ type: "text", text: err ? stderr : stdout }] });
    });
  });
}