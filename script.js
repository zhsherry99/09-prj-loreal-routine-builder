/* Get references to DOM elements */
const categoryFilter = document.getElementById("categoryFilter");
const productSearch = document.getElementById("productSearch");
const productsContainer = document.getElementById("productsContainer");
const chatForm = document.getElementById("chatForm");
const chatWindow = document.getElementById("chatWindow");
const generateBtn = document.getElementById("generateRoutine");
// const clearAllSelections = document.getElementById("clearAllSelections");

// RTL detection: languages that should render RTL
const RTL_LANGS = ["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv"];

function detectAndApplyRTL() {
  try {
    const docLang = (
      document.documentElement.lang ||
      navigator.language ||
      ""
    ).toLowerCase();
    const lang = docLang.split("-")[0];
    if (RTL_LANGS.includes(lang)) {
      document.documentElement.setAttribute("dir", "rtl");
      document.documentElement.classList.add("rtl");
    } else {
      document.documentElement.setAttribute("dir", "ltr");
      document.documentElement.classList.remove("rtl");
    }
  } catch (e) {
    // ignore
  }
}

// Observe changes to the document language attribute so we can react when
// Google Translate (or other tools) update the page language dynamically.
function observeLangAttributeChanges() {
  try {
    const target = document.documentElement;
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "lang") {
          // re-run detection when lang changes
          detectAndApplyRTL();
        }
      }
    });
    mo.observe(target, { attributes: true, attributeFilter: ["lang"] });
    // also attempt to detect when Google Translate injects its banner iframe
    // by watching for additions to the body; if an iframe with goog-appears,
    // re-run detection after a short delay.
    const bodyObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1 && node.tagName === "IFRAME") {
              // delay a bit for Translate to update attributes
              setTimeout(() => detectAndApplyRTL(), 300);
            }
          }
        }
      }
    });
    bodyObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    // ignore
  }
}

/* Conversation state for chat follow-ups */
let conversationMessages = [];
let routineGenerated = false; // set to true once the initial routine is produced

const systemInstruction = {
  role: "system",
  content:
    "You are a helpful skincare, haircare, makeup, and fragrance assistant. Only answer questions related to the provided routine or to topics like skincare, haircare, makeup, fragrance, and related product advice. Use up-to-date, real-world information when available and include links and short citations for any factual claims about current products, releases, or formulations. If the user asks about unrelated topics, politely decline and steer them back to the subject.",
};

function appendMessageToChat(role, content) {
  if (!chatWindow) return;
  const wrapper = document.createElement("div");
  wrapper.className =
    role === "user" ? "chat-msg user-msg" : "chat-msg assistant-msg";
  wrapper.innerHTML = `<div class="msg-role">${
    role === "user" ? "You" : "Advisor"
  }</div><div class="msg-body">${escapeHtml(content).replace(
    /\n/g,
    "<br>"
  )}</div>`;
  chatWindow.appendChild(wrapper);
  // keep the latest message visible
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function callOpenAIWithMessages(messages) {
  // prefer proxy worker
  const proxyUrl =
    window.CF_WORKER_URL ||
    window.CLOUDFLARE_WORKER_URL ||
    "https://lorealroutinebuilder.sherreo99.workers.dev";

  let resp;
  if (proxyUrl) {
    resp = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
  } else {
    const apiKey = window.OPENAI_API_KEY || window.OPENAIKEY || null;
    if (!apiKey)
      throw new Error(
        "No OpenAI API key found. Provide a worker URL or window.OPENAI_API_KEY."
      );

    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages,
        max_tokens: 700,
        temperature: 0.7,
      }),
    });
  }

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI API error: ${resp.status} - ${txt}`);
  }

  const data = await resp.json();
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : JSON.stringify(data, null, 2);
  return content;
}

/*
  performWebSearch(query)
  - Attempts to call a web-search proxy to retrieve current results.
  - The client must set window.SEARCH_PROXY_URL to a server-side endpoint that performs the web search (to avoid exposing search API keys).
  - The proxy should accept { q } and return { results: [{ title, snippet, url }] } or a raw array.
*/
async function performWebSearch(query) {
  try {
    const proxy = window.SEARCH_PROXY_URL || window.SEARCH_WORKER_URL || null;
    if (!proxy) return [];

    const r = await fetch(proxy, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: query }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    // support multiple shapes
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.results)) return j.results;
    return [];
  } catch (err) {
    return [];
  }
}

function appendCitationsToChat(results) {
  if (!chatWindow || !results || results.length === 0) return;
  const cont = document.createElement("div");
  cont.className = "chat-citations";
  cont.innerHTML =
    `<div class="citations-title">Sources:</div>` +
    results
      .slice(0, 5)
      .map(
        (r) =>
          `<div class="citation-item"><a href="${
            r.url
          }" target="_blank" rel="noopener noreferrer">${escapeHtml(
            r.title || r.url
          )}</a><div class="citation-snippet">${escapeHtml(
            r.snippet || ""
          ).slice(0, 200)}</div></div>`
      )
      .join("");
  chatWindow.appendChild(cont);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* Show initial placeholder until user selects a category */
productsContainer.innerHTML = `
  <div class="placeholder-message">
    Select a category to view products
  </div>
`;

/* Load product data from JSON file */
async function loadProducts() {
  const response = await fetch("products.json");
  const data = await response.json();
  return data.products;
}

/* Create HTML for displaying product cards */
let selectedProducts = [];
let productsById = {};
let allProducts = [];

function displayProducts(products) {
  // build a quick id -> product map so listeners can access product info later
  productsById = {};
  products.forEach((p) => (productsById[p.id] = p));

  // helper: highlight occurrences of the search term inside a text (case-insensitive)
  function highlightMatch(text, term) {
    if (!term) return escapeHtml(text);
    const lower = text.toLowerCase();
    const t = term.toLowerCase();
    let idx = 0;
    let out = "";
    let pos = 0;
    while ((idx = lower.indexOf(t, pos)) !== -1) {
      out += escapeHtml(text.slice(pos, idx));
      out += `<mark class="search-hit">${escapeHtml(
        text.slice(idx, idx + t.length)
      )}</mark>`;
      pos = idx + t.length;
    }
    out += escapeHtml(text.slice(pos));
    return out;
  }

  const currentSearch =
    productSearch && productSearch.value ? productSearch.value.trim() : "";

  productsContainer.innerHTML = products
    .map((product) => {
      const isSelected = selectedProducts.some((p) => p.id === product.id);
      const titleHtml = highlightMatch(product.name || "", currentSearch);
      return `
    <div class="product-card ${isSelected ? "selected" : ""}" data-id="${
        product.id
      }" role="button" tabindex="0" aria-pressed="${isSelected}">
      <span class="checkmark" aria-hidden="true">✔</span>
      <img src="${product.image}" alt="${escapeHtml(product.name)}">
      <div class="product-info">
        <h3>${titleHtml}</h3>
        <p>${escapeHtml(product.brand || "")}</p>
        <button class="learnmore-btn" data-id="${
          product.id
        }" aria-label="Learn more about ${escapeHtml(
        product.name
      )}">Learn more</button>
      </div>
    </div>
  `;
    })
    .join("");

  // attach event listeners to cards after rendering
  attachCardListeners();
}

function attachCardListeners() {
  const cards = productsContainer.querySelectorAll(".product-card");
  cards.forEach((card) => {
    // avoid attaching multiple listeners if re-rendering
    if (card.dataset.listenerAttached === "true") return;

    const toggle = () => toggleSelection(card);

    card.addEventListener("click", toggle);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    // Learn more button inside the card should open modal and not toggle selection
    const learnBtn = card.querySelector(".learnmore-btn");
    if (learnBtn) {
      learnBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = Number(learnBtn.dataset.id);
        const product = productsById[id];
        if (product) showProductModal(product, learnBtn);
      });
    }

    card.dataset.listenerAttached = "true";
  });
}

/* Persist selected product ids to localStorage */
function saveSelectedToStorage() {
  try {
    const ids = selectedProducts.map((p) => p.id);
    localStorage.setItem("selectedProductIds", JSON.stringify(ids));
  } catch (e) {
    // ignore
  }
}

/* Load selected product ids from localStorage and populate selectedProducts */
function loadSelectedFromStorage() {
  try {
    const raw = localStorage.getItem("selectedProductIds");
    if (!raw) return;
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return;
    // map ids to actual product objects if we have them
    if (allProducts && allProducts.length > 0) {
      selectedProducts = allProducts.filter((p) => ids.includes(p.id));
    } else {
      // store ids as placeholders (will be resolved after products load)
      selectedProducts = ids.map((id) => ({ id }));
    }
  } catch (e) {
    // ignore parse errors
  }
}

/* Clear all selections */
function clearAllSelections() {
  selectedProducts = [];
  saveSelectedToStorage();

  // remove selected classes from any rendered cards
  productsContainer.querySelectorAll(".product-card.selected").forEach((c) => {
    c.classList.remove("selected");
    c.setAttribute("aria-pressed", "false");
  });

  updateSelectedList();
}

/* Modal: show product description in a dialog */
let modalEl = null;
let lastFocused = null;

function createModal() {
  modalEl = document.createElement("div");
  modalEl.className = "modal-overlay";
  modalEl.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <button class="modal-close" aria-label="Close">✕</button>
      <div class="modal-header">
        <img class="modal-image" src="" alt="" />
        <div>
          <h3 class="modal-title"></h3>
          <p class="modal-brand"></p>
          <p class="modal-body"></p>
          <p class="modal-description"></p>
        </div>
      </div>
    </div>
  `;

  // close when clicking on overlay (but not when clicking inside modal)
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeProductModal();
  });

  document.body.appendChild(modalEl);

  // close button
  const closeBtn = modalEl.querySelector(".modal-close");
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeProductModal();
  });

  // ESC to close
  document.addEventListener("keydown", onKeyDownForModal);
}

function onKeyDownForModal(e) {
  if (!modalEl) return;
  if (e.key === "Escape") {
    closeProductModal();
  }
}

function showProductModal(product, opener) {
  if (!modalEl) createModal();
  lastFocused = opener || document.activeElement;

  modalEl.querySelector(".modal-title").textContent = product.name;
  modalEl.querySelector(".modal-body").textContent =
    product.description || "No description.";

  const img = modalEl.querySelector(".modal-image");
  if (img) {
    if (product.image) {
      img.src = product.image;
      img.alt = product.name || "Product image";
      img.style.display = "block";
    } else {
      img.style.display = "none";
    }
  }

  const brandEl = modalEl.querySelector(".modal-brand");
  if (brandEl) brandEl.textContent = product.brand || "";

  modalEl.classList.add("open");

  // move focus into modal (close button)
  const closeBtn = modalEl.querySelector(".modal-close");
  closeBtn.focus();
}

function closeProductModal() {
  if (!modalEl) return;
  // remove open to start CSS closing animation
  modalEl.classList.remove("open");
  // wait until animation finishes before returning focus (match CSS transition ~220ms)
  setTimeout(() => {
    if (lastFocused && typeof lastFocused.focus === "function")
      lastFocused.focus();
  }, 240);
}

function toggleSelection(cardEl) {
  const id = Number(cardEl.dataset.id);
  const product = productsById[id];
  if (!product) return;

  const index = selectedProducts.findIndex((p) => p.id === id);
  const isNowSelected = index === -1;

  if (isNowSelected) {
    selectedProducts.push(product);
    cardEl.classList.add("selected");
    cardEl.setAttribute("aria-pressed", "true");
  } else {
    selectedProducts.splice(index, 1);
    cardEl.classList.remove("selected");
    cardEl.setAttribute("aria-pressed", "false");
  }

  updateSelectedList();
}

function updateSelectedList() {
  const list = document.getElementById("selectedProductsList");
  if (!list) return;

  if (selectedProducts.length === 0) {
    list.innerHTML = `<div class="placeholder-message">No products selected</div>`;
    return;
  }

  list.innerHTML = selectedProducts
    .map(
      (p) => `
    <div class="selected-chip" data-id="${p.id}">
      <strong>${p.name}</strong>
      <button class="remove-chip" aria-label="Remove ${p.name}">✕</button>
    </div>
  `
    )
    .join("");

  // add remove handlers
  list.querySelectorAll(".selected-chip").forEach((chip) => {
    const removeBtn = chip.querySelector(".remove-chip");
    removeBtn.addEventListener("click", () => {
      const id = Number(chip.dataset.id);
      // remove from selectedProducts
      const idx = selectedProducts.findIndex((p) => p.id === id);
      if (idx !== -1) selectedProducts.splice(idx, 1);

      // remove selected class from any visible card
      const card = productsContainer.querySelector(
        `.product-card[data-id="${id}"]`
      );
      if (card) {
        card.classList.remove("selected");
        card.setAttribute("aria-pressed", "false");
      }

      updateSelectedList();
      saveSelectedToStorage();
    });

    // Clicking on the chip (not the remove button) should show all products
    // regardless of the current category filter, then scroll to the product.
    chip.addEventListener("click", (e) => {
      // ignore clicks on the remove button
      if (e.target.closest(".remove-chip")) return;

      // clear category filter so all products are visible
      if (categoryFilter) {
        try {
          categoryFilter.value = "";
        } catch (err) {}
      }
      // update grid to show all products (search term preserved)
      updateProductGrid();

      // after rendering, scroll to the product card and briefly highlight it
      const id = Number(chip.dataset.id);
      setTimeout(() => {
        const card = productsContainer.querySelector(
          `.product-card[data-id="${id}"]`
        );
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          card.classList.add("highlight");
          setTimeout(() => card.classList.remove("highlight"), 1200);
        }
      }, 120);
    });
  });
  // persist whenever the visible selected list changes
  saveSelectedToStorage();
}

/* Update product grid based on selected category and search term */
async function updateProductGrid() {
  const products =
    allProducts && allProducts.length > 0 ? allProducts : await loadProducts();
  const selectedCategory = categoryFilter ? categoryFilter.value : "";
  const searchTerm =
    productSearch && productSearch.value
      ? productSearch.value.trim().toLowerCase()
      : "";

  let filtered = products;
  if (selectedCategory) {
    filtered = filtered.filter(
      (product) => product.category === selectedCategory
    );
  }

  if (searchTerm) {
    // When searching, only match the term against the product title
    // (we still allow category filtering to apply unless chips clear it)
    filtered = filtered.filter((product) => {
      const title = (product.name || "").toLowerCase();
      return title.includes(searchTerm);
    });
  }

  if (!filtered || filtered.length === 0) {
    productsContainer.innerHTML = `<div class="placeholder-message">No products match your filters.</div>`;
    return;
  }

  displayProducts(filtered);
}

if (categoryFilter) {
  categoryFilter.addEventListener("change", updateProductGrid);
}

if (productSearch) {
  productSearch.addEventListener("input", updateProductGrid);
}

/* Chat form submission handler - send follow-up questions about the generated routine */
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  if (!input) return;
  const text = input.value && input.value.trim();
  if (!text) return;

  // require generating a routine first to ask follow-ups about it
  if (!routineGenerated) {
    appendMessageToChat(
      "assistant",
      "Please generate a routine first, then ask follow-up questions about it."
    );
    return;
  }

  // append user's question to chat and conversation history
  appendMessageToChat("user", text);
  conversationMessages.push({ role: "user", content: text });

  // attempt a web search for the user's question to provide up-to-date context
  // only if a search proxy is configured
  const webResults = await performWebSearch(text + " L'Oréal");
  if (webResults && webResults.length > 0) {
    // include formatted results as a system-context message so the model can cite them
    const formatted = webResults
      .slice(0, 6)
      .map(
        (r, i) => `${i + 1}. ${r.title || r.url}\n${r.snippet || ""}\n${r.url}`
      )
      .join("\n\n");
    conversationMessages.push({
      role: "system",
      content: `Web search results (top):\n\n${formatted}`,
    });
  }

  // disable send button while waiting
  if (sendBtn) sendBtn.disabled = true;

  try {
    const reply = await callOpenAIWithMessages(conversationMessages);
    // record assistant reply in history and UI
    conversationMessages.push({ role: "assistant", content: reply });
    appendMessageToChat("assistant", reply);
    // show citations if available
    if (webResults && webResults.length > 0) appendCitationsToChat(webResults);
  } catch (err) {
    appendMessageToChat("assistant", `Error: ${err.message}`);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    input.value = "";
  }
});

// initialize selected products list UI
updateSelectedList();

// Bind the existing Clear Selection button in the HTML (if present)
const existingClearBtn = document.getElementById("buttonClearSelection");
if (existingClearBtn) {
  existingClearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    clearAllSelections();
  });
}

// on load, fetch all products once and restore selections from storage
(async function init() {
  try {
    allProducts = await loadProducts();
    // resolve any placeholder selected ids to full objects
    const raw = localStorage.getItem("selectedProductIds");
    if (raw) {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length > 0) {
        selectedProducts = allProducts.filter((p) => ids.includes(p.id));
      }
    }
    // reflect any selections in the UI (if a category is already selected the cards will show selected when displayed)
    updateSelectedList();
    // detect language direction and apply RTL if needed
    detectAndApplyRTL();
    // observe dynamic language changes (e.g. Google Translate) and re-apply RTL when lang mutates
    observeLangAttributeChanges();
    // ensure the product grid reflects current filters/search on load
    updateProductGrid();
  } catch (e) {
    // ignore
  }
})();

/* Generate routine using OpenAI when the user clicks the button */
if (generateBtn) {
  generateBtn.addEventListener("click", async () => {
    // collect only selected products
    if (!selectedProducts || selectedProducts.length === 0) {
      appendMessageToChat(
        "assistant",
        "Please select one or more products first."
      );
      return;
    }

    const productsPayload = selectedProducts.map((p) => ({
      name: p.name,
      brand: p.brand,
      category: p.category,
      description: p.description,
    }));

    const userMsg = {
      role: "user",
      content:
        "Here are the selected products in JSON. Use these only and create a short routine (steps, timing, and brief why) formatted as plain text.\n\n" +
        JSON.stringify(productsPayload, null, 2),
    };

    // prepare conversation: start with the system instruction
    conversationMessages = [systemInstruction];
    conversationMessages.push(userMsg);

    // UI loading state
    const prevHtml = generateBtn.innerHTML;
    generateBtn.disabled = true;
    generateBtn.innerHTML = "Generating…";
    appendMessageToChat("assistant", "Generating routine… Please wait.");

    try {
      // run a web search for the selected products to provide current context
      const productNames = productsPayload.map((p) => p.name).join(", ");
      const webResults = await performWebSearch(
        `L'Oréal ${productNames} routine, product information, releases, or reviews`
      );

      if (webResults && webResults.length > 0) {
        const formatted = webResults
          .slice(0, 6)
          .map(
            (r, i) =>
              `${i + 1}. ${r.title || r.url}\n${r.snippet || ""}\n${r.url}`
          )
          .join("\n\n");
        conversationMessages.push({
          role: "system",
          content: `Web search results (top):\n\n${formatted}`,
        });
      }

      const content = await callOpenAIWithMessages(conversationMessages);

      // record assistant reply
      conversationMessages.push({ role: "assistant", content });
      routineGenerated = true;

      // display assistant reply
      appendMessageToChat("assistant", content);
      if (webResults && webResults.length > 0)
        appendCitationsToChat(webResults);
    } catch (err) {
      appendMessageToChat(
        "assistant",
        `Error generating routine: ${err.message}`
      );
    } finally {
      generateBtn.disabled = false;
      generateBtn.innerHTML = prevHtml;
    }
  });
}

// small helper to escape HTML when inserting model output
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
