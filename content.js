let running = false;
let delay = 3000;  // 你指定的 3 秒
let consecutiveFailures = 0;  // 連續翻頁失敗次數
const MAX_FAILURES = 3;  // 連續失敗 3 次就判定為最後一頁

// 防止在 iframe 中重複執行
if (window === window.top) {
  console.log("Content script loaded in main frame");

  chrome.runtime.onMessage.addListener(async (msg) => {
    console.log("Content script received message:", msg.type);
    if (msg.type === "BEGIN") {
      console.log("Starting auto capture loop");
      running = true;
      consecutiveFailures = 0;  // 重置失敗計數器
      // 等待 1 秒讓 iframe 完全載入
      console.log("Waiting 1 second for iframes to load...");
      await sleep(1000);

      // 先擷取第一頁（當前頁面）
      console.log("Capturing first page before flipping");
      chrome.runtime.sendMessage({ type: "CAPTURE_PAGE" });

      // 等待一下讓第一頁擷取完成
      await sleep(1000);

      // 然後開始翻頁循環
      startLoop();
    }
    if (msg.type === "STOP") {
      console.log("Stopping auto capture");
      running = false;
      consecutiveFailures = 0;  // 重置失敗計數器
    }
  });
} else {
  console.log("Content script in iframe, skipping message listener");
}

// 尋找真正的電子書 iframe
function getReaderFrame() {
  const frames = document.querySelectorAll("iframe");
  console.log("Found", frames.length, "iframes");

  if (frames.length === 0) {
    console.log("No iframe found, using main window");
    return window;
  }

  let maxArea = 0;
  let target = null;
  let targetWindow = null;

  frames.forEach((f, index) => {
    try {
      const rect = f.getBoundingClientRect();
      const area = rect.width * rect.height;
      console.log(`iframe ${index}: ${rect.width}x${rect.height}, area: ${area}`);

      // 嘗試訪問 contentWindow
      const cw = f.contentWindow;
      if (cw && cw.document && cw.document.body) {
        const innerW = cw.innerWidth;
        const innerH = cw.innerHeight;
        console.log(`  contentWindow accessible, inner size: ${innerW}x${innerH}`);

        // 只選擇可訪問且有實際尺寸的 iframe
        if (innerW > 0 && innerH > 0 && area > maxArea) {
          maxArea = area;
          target = f;
          targetWindow = cw;
        }
      } else {
        console.log(`  contentWindow not accessible (cross-origin or not loaded)`);
      }
    } catch (e) {
      console.log(`iframe ${index}: access error -`, e.message);
    }
  });

  if (targetWindow) {
    console.log("Selected iframe with contentWindow");
    return targetWindow;
  }

  console.log("No accessible iframe found, using main window");
  return window;
}

async function startLoop() {
  console.log("startLoop called, running:", running);
  if (!running) return;

  // Step 1: 翻頁
  console.log("Attempting to flip page...");
  const flipped = await flipPage();

  if (!flipped) {
    consecutiveFailures++;
    console.log(`翻頁失敗 (${consecutiveFailures}/${MAX_FAILURES})`);

    if (consecutiveFailures >= MAX_FAILURES) {
      console.log(`連續 ${MAX_FAILURES} 次翻頁失敗，判定已到達最後一頁，中止流程`);
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }); // 通知 background 停止
      running = false;
      consecutiveFailures = 0;
      return;
    }

    // 還沒達到上限，繼續嘗試
    console.log("繼續嘗試翻頁...");
    if (running) {
      setTimeout(startLoop, delay);
    }
    return;
  }

  // Step 2: 翻頁成功 → 重置失敗計數 → 請 background 儲存截圖
  consecutiveFailures = 0;
  console.log("Page flipped successfully, requesting capture");
  chrome.runtime.sendMessage({ type: "CAPTURE_PAGE" });

  // Step 3: 等待 delay 秒 → 下一輪
  if (running) {
    console.log(`Waiting ${delay}ms before next page...`);
    setTimeout(startLoop, delay);
  }
}

async function flipPage() {
  const readerWin = getReaderFrame();
  console.log("Reader window found:", readerWin !== window ? "iframe" : "main window");
  console.log("Window size:", readerWin.innerWidth, "x", readerWin.innerHeight);

  // 如果視窗大小為 0，無法翻頁
  if (readerWin.innerWidth === 0 || readerWin.innerHeight === 0) {
    console.error("Window size is 0, cannot flip page");
    return false;
  }

  const before = readerWin.document.body.innerHTML.length;
  console.log("HTML length before flip:", before);

  // 第一招：在 document.body 上觸發鍵盤事件
  console.log("Trying keyboard ArrowRight on document.body...");
  const keyEvent = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    code: "ArrowRight",
    keyCode: 39,
    which: 39,
    bubbles: true,
    cancelable: true
  });
  readerWin.document.body.dispatchEvent(keyEvent);

  await sleep(500);

  let afterKB = readerWin.document.body.innerHTML.length;
  console.log("HTML length after keyboard:", afterKB, "Changed:", afterKB !== before);
  if (afterKB !== before) {
    console.log("✓ 鍵盤翻頁成功 (HTML changed)");
    return true;
  }

  // 第二招：滑鼠點擊右側
  const x = Math.floor(readerWin.innerWidth * 0.85);
  const y = Math.floor(readerWin.innerHeight * 0.5);
  console.log(`Trying click at position: (${x}, ${y})`);

  const element = readerWin.document.elementFromPoint(x, y);
  console.log("Element at click position:", element ? element.tagName : "null", element);

  if (element) {
    element.click();
    console.log("Clicked element");

    // 等待更長時間讓頁面有時間改變（從 500ms 增加到 1000ms）
    await sleep(1000);

    const afterClick = readerWin.document.body.innerHTML.length;
    console.log("HTML length after click:", afterClick, "Changed:", afterClick !== before);

    if (afterClick !== before) {
      console.log("✓ 滑鼠翻頁成功 (HTML changed)");
      return true;
    }

    // HTML 沒變 → 可能已經到最後一頁
    console.log("✗ 滑鼠點擊後 HTML 沒有改變，可能已到最後一頁");
    return false;
  }

  // 兩種方式都失敗 → 返回 false
  console.log("✗ Both flip methods failed");
  return false;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
