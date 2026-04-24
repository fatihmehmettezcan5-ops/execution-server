import fetch from "node-fetch";

export async function generateImage(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;
  
  // Görselin oluşmasını bekle (ilk istek generate eder)
  const response = await fetch(imageUrl);
  
  if (!response.ok) {
    return {
      content: [{ type: "text", text: "Görsel oluşturulamadı." }]
    };
  }

  return {
    content: [
      {
        type: "image",
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
        mimeType: "image/jpeg"
      }
    ]
  };
}
