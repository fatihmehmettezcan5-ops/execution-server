export async function generateImage(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  
  return {
    content: [
      {
        type: "text",
        text: "🎨 **Bing Image Creator:** https://www.bing.com/images/create?q=" + encodedPrompt
      }
    ]
  };
}
