import fetch from "node-fetch";

export async function generateImage(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;

  try {
    // Görselin oluşmasını bekle
    const response = await fetch(imageUrl);

    if (!response.ok) {
      // Başarısız olursa Bing'e yönlendir
      return {
        content: [
          {
            type: "text",
            text: "⚠️ Görsel oluşturulamadı. Aşağıdaki linkten manuel olarak oluşturabilirsiniz:\n\n"
              + "🎨 **Bing Image Creator:** https://www.bing.com/images/create?q=" + encodedPrompt
          }
        ]
      };
    }

    // Görseli base64 olarak döndür + yedek linkler ekle
    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      content: [
        {
          type: "image",
          data: buffer.toString("base64"),
          mimeType: "image/jpeg"
        },
        {
          type: "text",
          text: "✅ Görsel oluşturuldu!"
            + "\n\n📌 Eğer görsel görünmüyorsa aşağıdaki linkleri kullanabilirsiniz:"
            + "\n\n🖼️ **Doğrudan görsel linki:** " + imageUrl
            + "\n🎨 **Bing Image Creator:** https://www.bing.com/images/create?q=" + encodedPrompt
        }
      ]
    };

  } catch (error) {
    // Hata durumunda Bing'e yönlendir
    return {
      content: [
        {
          type: "text",
          text: "⚠️ Görsel oluşturulurken bir hata oluştu."
            + "\n\nAşağıdaki linklerden görsel oluşturabilirsiniz:"
            + "\n\n🎨 **Bing Image Creator:** https://www.bing.com/images/create?q=" + encodedPrompt
            + "\n🖼️ **Pollinations (Direkt link):** " + imageUrl
        }
      ]
    };
  }
}
