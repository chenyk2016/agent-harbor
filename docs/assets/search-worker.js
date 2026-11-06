// Keep MkDocs' index and search dialog. Match Chinese without requiring word separators.
let documents = [];

async function init() {
  const response = await fetch(new URL("search_index.json", self.location.href));
  if (!response.ok) throw new Error("Documentation search index is unavailable");
  const { config, docs } = await response.json();
  documents = docs.map((doc) => ({
    ...doc,
    titleForSearch: doc.title.toLowerCase(),
    textForSearch: doc.text.toLowerCase(),
  }));
  self.postMessage({ config });
  self.postMessage({ allowSearch: true });
}

function search(query) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  return documents
    .filter((doc) => terms.every((term) =>
      doc.titleForSearch.includes(term) || doc.textForSearch.includes(term)))
    .map((doc) => {
      const firstMatch = doc.textForSearch.indexOf(terms[0]);
      const excerptStart = Math.max(0, firstMatch - 35);
      return {
        title: doc.title,
        location: doc.location,
        summary: doc.text.slice(excerptStart, excerptStart + 150),
        score: terms.filter((term) => doc.titleForSearch.includes(term)).length,
      };
    })
    .sort((first, second) => second.score - first.score)
    .slice(0, 20);
}

self.addEventListener("message", ({ data }) => {
  if (data.init) void init();
  else self.postMessage({ results: search(data.query) });
});
