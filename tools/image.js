import fetch from "node-fetch";

export async function generateImage(prompt) {
  const response = await fetch("https://openrouter.ai/api/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "black-forest-labs/flux-1-dev",
      prompt,
      size: "1024x1024"
    })
  });
  const data = await response.json();
  return {
    content: [{ type: "text", text: data?.data?.[0]?.url || "Failed." }]
  };
}