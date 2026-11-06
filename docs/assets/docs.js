// MkDocs listens to keyup. Handle paste, IME composition and mobile input too.
document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("mkdocs-search-query");
  searchInput?.addEventListener("input", (event) => {
    if (!event.isComposing) doSearch();
  });
});
