let running = false;
let delay = 500;  // 翻頁間隔（已優化為 500ms，因為是完全串行執行）
let consecutiveFailures = 0;  // 連續翻頁失敗次數
const MAX_FAILURES = 8;  // 連續失敗 8 次就判定為最後一頁（進一步增加容錯）
let flipDirection = 'right';  // ✨ v2.1：翻頁方向（'right' 或 'left'）

// 防止在 iframe 中重複執行
if (window === window.top) {
  console.log("Content script loaded in main frame");

  chrome.runtime.onMessage.addListener(async (msg) => {
    console.log("Content script received message:", msg.type);
    if (msg.type === "BEGIN") {
      console.log("Starting auto capture loop");
      running = true;
      consecutiveFailures = 0;  // 重置失敗計數器

      // ✨ v2.1：接收翻頁方向
      flipDirection = msg.flipDirection || 'right';
      const directionText = flipDirection === 'left' ? '向左 ←' : '向右 →';
      console.log(`✨ 翻頁方向設定為：${directionText}`);

      // 等待 1 秒讓 iframe 完全載入
      console.log("Waiting 1 second for iframes to load...");
      await sleep(1000);

      // 先擷取第一頁（當前頁面）並等待完成
      console.log("📸 開始擷取第一頁（當前頁面）");
      try {
        const response = await chrome.runtime.sendMessage({ type: "CAPTURE_PAGE" });
        if (response && response.ok) {
          console.log(`✅ 第一頁擷取成功，頁碼：${response.pageNumber}`);
        } else {
          const errorMsg = response?.error || "未知錯誤";
          console.error(`❌ 第一頁擷取失敗: ${errorMsg}`);
          console.error(`⚠️ 無法繼續，停止流程`);
          running = false;
          return;
        }
      } catch (error) {
        console.error(`❌ 第一頁擷取發生異常:`, error);
        running = false;
        return;
      }

      // 第一頁擷取完成後，開始翻頁循環
      console.log("⏳ 第一頁完成，準備開始翻頁循環...");
      await sleep(500);  // 短暫等待
      await startLoop();  // 使用 while 循環（非遞迴）
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

// ✨ v2.0 重構：使用 while 循環取代遞迴，避免堆疊溢出
async function startLoop() {
  console.log("🔄 [v2.0] startLoop 開始執行（使用 while 循環）");

  // 使用 while 循環取代遞迴調用
  while (running) {
    // Step 1: 嘗試翻頁
    console.log("📄 Attempting to flip page...");
    const flipped = await flipPage();

    if (!flipped) {
      // 翻頁失敗處理
      consecutiveFailures++;
      console.log(`⚠️ 翻頁失敗 (${consecutiveFailures}/${MAX_FAILURES})`);

      if (consecutiveFailures >= MAX_FAILURES) {
        // 達到最大失敗次數，判定為最後一頁
        console.log(`❌ 連續 ${MAX_FAILURES} 次翻頁失敗，判定已到達最後一頁`);
        chrome.runtime.sendMessage({ type: "AUTO_STOP_CAPTURE" });
        running = false;
        consecutiveFailures = 0;
        break;  // 退出循環（取代 return）
      }

      // 還有重試機會，增加等待時間後繼續
      const retryDelay = delay + (consecutiveFailures * 500);
      console.log(`🔄 還有 ${MAX_FAILURES - consecutiveFailures} 次重試機會，等待 ${retryDelay}ms 後重試`);
      await sleep(retryDelay);
      continue;  // 跳過本次迭代，繼續下一次循環
    }

    // Step 2: 翻頁成功，重置失敗計數
    consecutiveFailures = 0;
    console.log("✅ 翻頁成功，等待 500ms 讓頁面穩定");

    // 等待頁面穩定
    await sleep(500);

    // Step 3: 發送擷取請求
    let captureSuccess = false;
    try {
      const response = await chrome.runtime.sendMessage({ type: "CAPTURE_PAGE" });
      if (response && response.ok) {
        console.log(`📸 擷取成功，頁碼：${response.pageNumber}`);
        captureSuccess = true;
      } else {
        const errorMsg = response?.error || "未知錯誤";
        console.error(`❌ 擷取失敗（已重試 ${response?.retries || 5} 次）: ${errorMsg}`);
        console.error(`完整 response:`, response);
      }
    } catch (error) {
      console.error(`❌ 擷取請求發生異常:`, error.message || error);
      console.error(`異常詳情:`, error);
    }

    // Step 4: 檢查擷取是否成功
    if (!captureSuccess) {
      console.error(`🛑 擷取失敗，停止流程以避免缺頁`);
      console.error(`建議：請檢查瀏覽器視窗是否在前景、標籤頁是否正確`);
      running = false;
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      break;  // 退出循環
    }

    // Step 5: 等待後進入下一次迭代
    if (running) {
      console.log(`⏳ 等待 ${delay}ms 後翻下一頁`);
      await sleep(delay);
    }
  }

  console.log("🏁 startLoop 循環結束");
}

// ✨ v2.0 改進：使用雜湊值檢測頁面變化，更準確判斷翻頁成功
function getPageState(win) {
  try {
    const html = win.document.body.innerHTML;
    const url = win.location.href;
    const scroll = `${win.scrollX},${win.scrollY}`;

    // 提取可見文字內容（更準確）
    const visibleText = win.document.body.innerText || '';

    // 簡單的字串雜湊函數（使用 djb2 演算法）
    function hashString(str) {
      let hash = 5381;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
        hash = hash & hash; // Convert to 32bit integer
      }
      return hash;
    }

    return {
      htmlHash: hashString(html),
      htmlLength: html.length,
      textHash: hashString(visibleText.substring(0, 5000)), // 只取前 5000 字元避免過慢
      textLength: visibleText.length,
      url: url,
      scroll: scroll,
      imageCount: win.document.images.length
    };
  } catch (error) {
    console.error("❌ 無法獲取頁面狀態:", error);
    return null;
  }
}

async function flipPage() {
  const readerWin = getReaderFrame();
  console.log("Reader window found:", readerWin !== window ? "iframe" : "main window");
  console.log("Window size:", readerWin.innerWidth, "x", readerWin.innerHeight);

  // 如果視窗大小為 0，無法翻頁
  if (readerWin.innerWidth === 0 || readerWin.innerHeight === 0) {
    console.error("❌ Window size is 0, cannot flip page");
    return false;
  }

  // 記錄翻頁前的狀態（使用雜湊值）
  const stateBefore = getPageState(readerWin);
  if (!stateBefore) {
    console.error("❌ 無法獲取翻頁前的頁面狀態");
    return false;
  }

  console.log("Before flip - HTML hash:", stateBefore.htmlHash,
              "Text hash:", stateBefore.textHash,
              "URL:", stateBefore.url,
              "Scroll:", stateBefore.scroll);

  // ✨ v2.1：根據翻頁方向使用不同的按鍵
  const isLeftFlip = flipDirection === 'left';
  const arrowKey = isLeftFlip ? 'ArrowLeft' : 'ArrowRight';
  const keyCode = isLeftFlip ? 37 : 39;  // ArrowLeft: 37, ArrowRight: 39
  const directionSymbol = isLeftFlip ? '←' : '→';

  console.log(`⌨️ Triggering keyboard ${arrowKey} ${directionSymbol}...`);
  const keyEvent = new KeyboardEvent("keydown", {
    key: arrowKey,
    code: arrowKey,
    keyCode: keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true
  });
  readerWin.document.body.dispatchEvent(keyEvent);

  // 等待頁面更新（優化為 1.5 秒）
  await sleep(1500);

  // 檢查翻頁後的狀態
  const stateAfter = getPageState(readerWin);
  if (!stateAfter) {
    console.error("❌ 無法獲取翻頁後的頁面狀態");
    return false;
  }

  console.log("After flip - HTML hash:", stateAfter.htmlHash,
              "Text hash:", stateAfter.textHash,
              "URL:", stateAfter.url,
              "Scroll:", stateAfter.scroll);

  // ✨ v2.0 改進：使用多維度檢測，更準確判斷翻頁成功
  const htmlHashChanged = stateAfter.htmlHash !== stateBefore.htmlHash;
  const textHashChanged = stateAfter.textHash !== stateBefore.textHash;
  const urlChanged = stateAfter.url !== stateBefore.url;
  const scrollChanged = stateAfter.scroll !== stateBefore.scroll;
  const imageCountChanged = stateAfter.imageCount !== stateBefore.imageCount;

  // 文字內容變化是最可靠的指標
  const hasSignificantChange = textHashChanged || urlChanged ||
                                (htmlHashChanged && imageCountChanged);

  if (hasSignificantChange) {
    console.log(`✓ 翻頁成功 (TextHash: ${textHashChanged ? '✓' : '✗'}, ` +
                `URL: ${urlChanged ? '✓' : '✗'}, ` +
                `HTML: ${htmlHashChanged ? '✓' : '✗'}, ` +
                `Images: ${imageCountChanged ? '✓' : '✗'}, ` +
                `Scroll: ${scrollChanged ? '✓' : '✗'})`);
    return true;
  }

  // 沒有顯著變化 → 翻頁失敗
  console.log("✗ 翻頁失敗 (no significant change detected)");
  return false;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
