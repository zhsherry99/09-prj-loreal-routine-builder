/* Get references to DOM elements */
const categoryFilter = document.getElementById("categoryFilter");
const productsContainer = document.getElementById("productsContainer");
const chatForm = document.getElementById("chatForm");
const chatWindow = document.getElementById("chatWindow");
const generateBtn = document.getElementById("generateRoutine");

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

function displayProducts(products) {
  // build a quick id -> product map so listeners can access product info later
  productsById = {};
  products.forEach((p) => (productsById[p.id] = p));

  productsContainer.innerHTML = products
    .map((product) => {
      const isSelected = selectedProducts.some((p) => p.id === product.id);
      return `
    <div class="product-card ${isSelected ? "selected" : ""}" data-id="${
        product.id
      }" role="button" tabindex="0" aria-pressed="${isSelected}">
      <span class="checkmark" aria-hidden="true">✔</span>
      <img src="${product.image}" alt="${product.name}">
      <div class="product-info">
        <h3>${product.name}</h3>
        <p>${product.brand}</p>
        <button class="learnmore-btn" data-id="${
          product.id
        }" aria-label="Learn more about ${product.name}">Learn more</button>
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
    });
  });
}

/* Filter and display products when category changes */
categoryFilter.addEventListener("change", async (e) => {
  const products = await loadProducts();
  const selectedCategory = e.target.value;

  /* filter() creates a new array containing only products 
     where the category matches what the user selected */
  const filteredProducts = products.filter(
    (product) => product.category === selectedCategory
  );

  displayProducts(filteredProducts);
});

/* Chat form submission handler - placeholder for OpenAI integration */
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();

  chatWindow.innerHTML = "Connect to the OpenAI API for a response!";
});

// initialize selected products list UI
updateSelectedList();

/* Generate routine using OpenAI when the user clicks the button */
if (generateBtn) {
  generateBtn.addEventListener("click", async () => {
    // collect only selected products
    if (!selectedProducts || selectedProducts.length === 0) {
      chatWindow.innerHTML = `<div class="placeholder-message">Please select one or more products first.</div>`;
      return;
    }

    // prepare JSON with required fields
    const productsPayload = selectedProducts.map((p) => ({
      name: p.name,
      brand: p.brand,
      category: p.category,
      description: p.description,
    }));

    // prepare messages per project guideline (use messages, async/await)
    const systemMsg = {
      role: "system",
      content:
        "You are a helpful skincare and haircare routine assistant. Given a set of products, produce a clear, ordered daily routine that indicates when to use each product (AM / PM / as needed), short reasons, and any cautions.",
    };

    const userMsg = {
      role: "user",
      content:
        "Here are the selected products in JSON. Use these only and create a short routine (steps, timing, and brief why) formatted as plain text.\n\n" +
        JSON.stringify(productsPayload, null, 2),
    };

    // show loading state
    const prevHtml = generateBtn.innerHTML;
    generateBtn.disabled = true;
    generateBtn.innerHTML = "Generating…";
    chatWindow.innerHTML = "Generating routine… Please wait.";

    try {
      // Prefer calling a Cloudflare Worker (or other proxy) that holds the OpenAI API key
      // Provide the worker URL via window.CF_WORKER_URL or window.CLOUDFLARE_WORKER_URL
      const proxyUrl =
        window.CF_WORKER_URL ||
        window.CLOUDFLARE_WORKER_URL ||
        "https://lorealroutinebuilder.sherreo99.workers.dev";

      let resp;
      if (proxyUrl) {
        // The worker expects a JSON body with { messages: [...] } (see cloudfare.js template)
        resp = await fetch(proxyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: [systemMsg, userMsg] }),
        });
      } else {
        // Fallback: call OpenAI directly from the browser (requires window.OPENAI_API_KEY)
        const apiKey = window.OPENAI_API_KEY || window.OPENAIKEY || null;
        if (!apiKey) {
          chatWindow.innerHTML = `<div class="placeholder-message">No OpenAI API key found. Add a <code>secrets.js</code> that sets <code>window.OPENAI_API_KEY</code>, or deploy a Cloudflare Worker and set <code>window.CF_WORKER_URL</code> to its URL.</div>`;
          return;
        }

        resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [systemMsg, userMsg],
            max_tokens: 700,
            temperature: 0.7,
          }),
        });
      }

      if (!resp.ok) {
        const errText = await resp.text();
        chatWindow.innerHTML = `<div class="placeholder-message">OpenAI API error: ${resp.status} - ${errText}</div>`;
        return;
      }

      const data = await resp.json();
      const content =
        data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : JSON.stringify(data, null, 2);

      // display AI-generated routine in chat window (preserve newlines)
      chatWindow.innerHTML = `<div class="ai-response">${escapeHtml(
        content
      ).replace(/\n/g, "<br>")}</div>`;
    } catch (err) {
      chatWindow.innerHTML = `<div class="placeholder-message">Error generating routine: ${err.message}</div>`;
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
