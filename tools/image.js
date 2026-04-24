export async function generateImage(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  const url = "https://www.bing.com/images/create?q=" + encodedPrompt;

  return {
    content: [
      {
        type: "text",
        text: "Maalesef doğrudan görsel oluşturma yeteneğim bulunmuyor. Ancak aşağıdaki bağlantıyı tarayıcınıza yapıştırarak Bing Image Creator üzerinden görselinizi oluşturabilirsiniz:\n\n" + url
      }
    ]
  };
}
