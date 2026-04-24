import fetch from "node-fetch";

export async function webFetch(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { content: [{ type: "text", text: text.slice(0, 4000) }] };
}