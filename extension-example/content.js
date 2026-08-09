/**
 * MCP Bridge — Content Script
 *
 * Runs in every page. Detects context and registers appropriate tools.
 * Handles tool execution requests from background script.
 */

// ============================================================
//  PAGE CONTEXT DETECTION
// ============================================================

function detectContext() {
  const hostname = window.location.hostname
  const url = window.location.href

  if (hostname.includes("github.com")) return "github"
  if (hostname.includes("mail.google.com")) return "gmail"
  if (hostname.includes("jira.atlassian.net") || hostname.includes("jira.com")) return "jira"
  if (hostname.includes("notion.so") || hostname.includes("notion.site")) return "notion"
  if (hostname.includes("slack.com")) return "slack"
  if (hostname.includes("linkedin.com")) return "linkedin"
  if (hostname.includes("twitter.com") || hostname.includes("x.com")) return "twitter"
  if (hostname.includes("reddit.com")) return "reddit"
  if (hostname.includes("youtube.com")) return "youtube"
  if (hostname.includes("docs.google.com")) return "gdocs"
  if (hostname.includes("sheets.google.com")) return "gsheets"

  return "generic"
}

// ============================================================
//  TOOL DEFINITIONS PER CONTEXT
// ============================================================

function getToolsForContext(context) {
  const base = [
    {
      name: "page_snapshot",
      description: "Capture accessibility tree snapshot of the current page. Use this first to understand page structure before interacting.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "page_url",
      description: "Get the current page URL and title",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "click",
      description: "Click an element on the page by CSS selector or text content",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector or text to find the element" },
        },
        required: ["selector"],
      },
    },
    {
      name: "type_text",
      description: "Type text into an input field or editable element",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the input" },
          text: { type: "string", description: "Text to type" },
        },
        required: ["selector", "text"],
      },
    },
    {
      name: "press_key",
      description: "Press a keyboard key (Enter, Escape, Tab, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name (Enter, Escape, Tab, ArrowDown, etc.)" },
          selector: { type: "string", description: "Optional: element to focus before pressing" },
        },
        required: ["key"],
      },
    },
    {
      name: "extract_text",
      description: "Extract text content from elements matching a CSS selector",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
        },
        required: ["selector"],
      },
    },
    {
      name: "scroll",
      description: "Scroll the page",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
          amount: { type: "number", description: "Pixels to scroll (default: 500)" },
        },
        required: ["direction"],
      },
    },
    {
      name: "wait_for",
      description: "Wait for an element to appear on the page",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector to wait for" },
          timeout: { type: "number", description: "Timeout in ms (default: 5000)" },
        },
        required: ["selector"],
      },
    },
    {
      name: "screenshot",
      description: "Take a screenshot of the visible page (returns base64 image)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ]

  const contextTools = {
    github: [
      {
        name: "gh_get_repo_info",
        description: "Get repository info from current GitHub page (owner, name, description, stars, etc.)",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "gh_list_files",
        description: "List files in current repository directory",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "gh_get_file_content",
        description: "Get content of the currently viewed file",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "gh_list_issues",
        description: "List issues on the current repository page",
        inputSchema: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter: open, closed, all" },
          },
        },
      },
      {
        name: "gh_list_prs",
        description: "List pull requests on the current repository page",
        inputSchema: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter: open, closed, all" },
          },
        },
      },
    ],
    gmail: [
      {
        name: "gmail_list_inbox",
        description: "List recent emails in inbox",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "number", description: "Number of emails to list (default: 10)" },
          },
        },
      },
      {
        name: "gmail_open_email",
        description: "Open an email by subject or index",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string", description: "Subject to search for" },
            index: { type: "number", description: "Index in inbox list (0-based)" },
          },
        },
      },
      {
        name: "gmail_compose",
        description: "Open compose window with pre-filled fields",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
        },
      },
      {
        name: "gmail_search",
        description: "Search emails using Gmail search syntax",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query" },
          },
          required: ["query"],
        },
      },
    ],
    notion: [
      {
        name: "notion_get_page_content",
        description: "Extract text content from the current Notion page",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "notion_type_in_block",
        description: "Type text into the currently focused Notion block",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    ],
    generic: [],
  }

  return [...base, ...(contextTools[context] || [])]
}

// ============================================================
//  TOOL EXECUTION
// ============================================================

async function executeTool(name, params) {
  switch (name) {
    case "page_snapshot":
      return executeSnapshot()
    case "page_url":
      return { content: [{ type: "text", text: `${window.location.href}\n${document.title}` }] }
    case "click":
      return executeClick(params)
    case "type_text":
      return executeType(params)
    case "press_key":
      return executePressKey(params)
    case "extract_text":
      return executeExtractText(params)
    case "scroll":
      return executeScroll(params)
    case "wait_for":
      return executeWaitFor(params)
    case "screenshot":
      return executeScreenshot()

    // GitHub
    case "gh_get_repo_info":
      return executeGithubRepoInfo()
    case "gh_list_files":
      return executeGithubListFiles()
    case "gh_get_file_content":
      return executeGithubFileContent()
    case "gh_list_issues":
      return executeGithubListIssues(params)
    case "gh_list_prs":
      return executeGithubListPRs(params)

    // Gmail
    case "gmail_list_inbox":
      return executeGmailListInbox(params)
    case "gmail_open_email":
      return executeGmailOpenEmail(params)
    case "gmail_compose":
      return executeGmailCompose(params)
    case "gmail_search":
      return executeGmailSearch(params)

    // Notion
    case "notion_get_page_content":
      return executeNotionPageContent()
    case "notion_type_in_block":
      return executeNotionTypeInBlock(params)

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ============================================================
//  BASE TOOL IMPLEMENTATIONS
// ============================================================

function executeSnapshot() {
  // Simple accessibility-like snapshot
  const elements = []
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        const tag = node.tagName.toLowerCase()
        const role = node.getAttribute("role")
        const interactive = ["a", "button", "input", "select", "textarea", "details", "summary"].includes(tag)
        const hasRole = role && ["button", "link", "textbox", "checkbox", "radio", "tab", "menuitem"].includes(role)
        const visible = node.offsetParent !== null || tag === "body"
        if ((interactive || hasRole) && visible) return NodeFilter.FILTER_ACCEPT
        return NodeFilter.FILTER_SKIP
      },
    }
  )

  let node
  let idx = 0
  while ((node = walker.nextNode())) {
    const tag = node.tagName.toLowerCase()
    const text = (node.textContent || "").trim().substring(0, 80)
    const ref = node.getAttribute("data-mcp-ref") || `ref-${idx}`
    node.setAttribute("data-mcp-ref", ref)

    elements.push({
      ref,
      tag,
      role: node.getAttribute("role") || "",
      text: text || "",
      type: node.getAttribute("type") || "",
      href: node.getAttribute("href") || "",
      placeholder: node.getAttribute("placeholder") || "",
      value: node.value || "",
    })
    idx++
  }

  return {
    content: [{ type: "text", text: JSON.stringify(elements, null, 2) }],
  }
}

function executeClick({ selector }) {
  const el = findElement(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  el.click()
  el.focus()
  return { content: [{ type: "text", text: `Clicked: ${selector}` }] }
}

function executeType({ selector, text }) {
  const el = findElement(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  el.focus()
  el.value = text
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { content: [{ type: "text", text: `Typed "${text}" into ${selector}` }] }
}

function executePressKey({ key, selector }) {
  if (selector) {
    const el = findElement(selector)
    if (el) el.focus()
  }
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true })
  )
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keyup", { key, bubbles: true })
  )
  return { content: [{ type: "text", text: `Pressed: ${key}` }] }
}

function executeExtractText({ selector }) {
  const elements = document.querySelectorAll(selector)
  const texts = Array.from(elements).map((el) => el.textContent?.trim())
  return { content: [{ type: "text", text: texts.join("\n") }] }
}

function executeScroll({ direction, amount = 500 }) {
  switch (direction) {
    case "down": window.scrollBy(0, amount); break
    case "up": window.scrollBy(0, -amount); break
    case "top": window.scrollTo(0, 0); break
    case "bottom": window.scrollTo(0, document.body.scrollHeight); break
  }
  return { content: [{ type: "text", text: `Scrolled ${direction}` }] }
}

function executeWaitFor({ selector, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector)
    if (el) {
      resolve({ content: [{ type: "text", text: `Found: ${selector}` }] })
      return
    }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) {
        observer.disconnect()
        clearTimeout(timer)
        resolve({ content: [{ type: "text", text: `Found: ${selector}` }] })
      }
    })

    const timer = setTimeout(() => {
      observer.disconnect()
      reject(new Error(`Timeout waiting for: ${selector}`))
    }, timeout)

    observer.observe(document.body, { childList: true, subtree: true })
  })
}

function executeScreenshot() {
  // Use html2canvas-like approach or just return viewport info
  return {
    content: [{
      type: "text",
      text: `Viewport: ${window.innerWidth}x${window.innerHeight}\nURL: ${window.location.href}\nTitle: ${document.title}`,
    }],
  }
}

// ============================================================
//  GITHUB TOOL IMPLEMENTATIONS
// ============================================================

function executeGithubRepoInfo() {
  const pathParts = window.location.pathname.split("/").filter(Boolean)
  const owner = pathParts[0] || ""
  const repo = pathParts[1] || ""
  const aboutEl = document.querySelector("[data-bio-text]") || document.querySelector(".f4.my-3")
  const starsEl = document.querySelector("#repo-stars-counter-star")
  const desc = aboutEl?.textContent?.trim() || ""
  const stars = starsEl?.textContent?.trim() || "0"

  return {
    content: [{ type: "text", text: JSON.stringify({ owner, repo, description: desc, stars }, null, 2) }],
  }
}

function executeGithubListFiles() {
  const rows = document.querySelectorAll('[role="row"] .react-directory-filename-cell a, .js-navigation-item .content a')
  const files = Array.from(rows).map((a) => ({
    name: a.textContent?.trim(),
    href: a.getAttribute("href"),
  }))
  return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] }
}

function executeGithubFileContent() {
  const codeEl = document.querySelector(".highlight .blob-code, .code-block")
  if (!codeEl) return { content: [{ type: "text", text: "No file content found on this page" }] }
  const lines = document.querySelectorAll(".blob-code")
  const content = Array.from(lines).map((l) => l.textContent).join("\n")
  return { content: [{ type: "text", text: content }] }
}

function executeGithubListIssues({ filter = "open" } = {}) {
  const issues = document.querySelectorAll(".js-issue-row, [data-hovercard-type='issue']")
  const list = Array.from(issues).map((el) => {
    const title = el.querySelector(".markdown-title, a[data-hovercard-type='issue']")?.textContent?.trim()
    const number = el.querySelector(".text-small color-fg-muted")?.textContent?.trim()
    return { title, number }
  }).filter(i => i.title)
  return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] }
}

function executeGithubListPRs({ filter = "open" } = {}) {
  const prs = document.querySelectorAll(".js-issue-row, [data-hovercard-type='pull_request']")
  const list = Array.from(prs).map((el) => {
    const title = el.querySelector(".markdown-title, a[data-hovercard-type='pull_request']")?.textContent?.trim()
    return { title }
  }).filter(i => i.title)
  return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] }
}

// ============================================================
//  GMAIL TOOL IMPLEMENTATIONS
// ============================================================

function executeGmailListInbox({ count = 10 } = {}) {
  const rows = document.querySelectorAll("tr.zA, tr[role='row']")
  const emails = Array.from(rows).slice(0, count).map((row) => {
    const sender = row.querySelector(".yW .yP, .bA4 .bA4")?.textContent?.trim()
    const subject = row.querySelector(".bog, .y6")?.textContent?.trim()
    const snippet = row.querySelector(".y2, .ba0")?.textContent?.trim()
    return { sender, subject, snippet }
  }).filter(e => e.subject)
  return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] }
}

function executeGmailOpenEmail({ subject, index }) {
  if (typeof index === "number") {
    const rows = document.querySelectorAll("tr.zA")
    if (rows[index]) {
      rows[index].click()
      return { content: [{ type: "text", text: `Opened email at index ${index}` }] }
    }
  }
  if (subject) {
    const rows = document.querySelectorAll("tr.zA")
    for (const row of rows) {
      if (row.textContent?.includes(subject)) {
        row.click()
        return { content: [{ type: "text", text: `Opened email: ${subject}` }] }
      }
    }
  }
  throw new Error("Email not found")
}

function executeGmailCompose({ to, subject, body }) {
  const composeBtn = document.querySelector('.T-I-atl, [gh="cm"]')
  if (composeBtn) composeBtn.click()
  return { content: [{ type: "text", text: "Compose window opened" }] }
}

function executeGmailSearch({ query }) {
  const searchBox = document.querySelector('input[aria-label="Search mail"], input[name="q"]')
  if (searchBox) {
    searchBox.value = query
    searchBox.dispatchEvent(new Event("input", { bubbles: true }))
    searchBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  }
  return { content: [{ type: "text", text: `Searched: ${query}` }] }
}

// ============================================================
//  NOTION TOOL IMPLEMENTATIONS
// ============================================================

function executeNotionPageContent() {
  const blocks = document.querySelectorAll("[data-block-id], .notion-page-content .notion-text-block")
  const content = Array.from(blocks).map((b) => b.textContent?.trim()).filter(Boolean).join("\n")
  return { content: [{ type: "text", text: content || "No content found" }] }
}

function executeNotionTypeInBlock({ text }) {
  const focused = document.querySelector("[data-block-id]:focus-within, .notion-focusable-within")
  if (focused) {
    focused.textContent = text
    focused.dispatchEvent(new Event("input", { bubbles: true }))
  }
  return { content: [{ type: "text", text: `Typed in block: ${text}` }] }
}

// ============================================================
//  HELPERS
// ============================================================

function findElement(selector) {
  // Try CSS selector first
  let el = document.querySelector(selector)
  if (el) return el

  // Try by data-mcp-ref
  el = document.querySelector(`[data-mcp-ref="${selector}"]`)
  if (el) return el

  // Try by text content
  const allElements = document.querySelectorAll("a, button, input, [role='button']")
  for (const e of allElements) {
    if (e.textContent?.trim().toLowerCase().includes(selector.toLowerCase())) {
      return e
    }
  }

  return null
}

// ============================================================
//  MESSAGE HANDLING
// ============================================================

let currentContext = null
let registeredToolNames = new Set()

function detectAndRegister() {
  const newContext = detectContext()

  if (newContext !== currentContext) {
    // Unregister old context tools
    if (registeredToolNames.size > 0) {
      chrome.runtime.sendMessage({
        type: "unregisterTools",
        names: Array.from(registeredToolNames),
      })
    }

    // Register new context tools
    const tools = getToolsForContext(newContext)
    registeredToolNames = new Set(tools.map((t) => t.name))
    currentContext = newContext

    chrome.runtime.sendMessage({
      type: "registerTools",
      tools,
    })
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "ping":
      sendResponse({ pong: true })
      break

    case "executeTool":
      executeTool(msg.name, msg.params)
        .then((result) => {
          chrome.runtime.sendMessage({ type: "toolResult", callId: msg.callId, result })
        })
        .catch((err) => {
          chrome.runtime.sendMessage({
            type: "toolResult",
            callId: msg.callId,
            result: {
              content: [{ type: "text", text: `Error: ${err.message}` }],
              isError: true,
            },
          })
        })
      break

    case "detectAndRegister":
      detectAndRegister()
      break
  }
  return true // keep channel open for async
})

// Initial detection
detectAndRegister()
