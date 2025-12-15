// 引入 jsPDF 庫
importScripts('jspdf.umd.min.js');

// ✨ v2.0 新增：Mutex 互斥鎖類別，確保同時只有一個擷取操作
class Mutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async lock() {
    // 如果沒有被鎖定，直接鎖定並返回
    if (!this.locked) {
      this.locked = true;
      console.log('🔒 Mutex 已鎖定');
      return;
    }

    // 如果已被鎖定，加入等待隊列
    console.log('⏳ Mutex 已被鎖定，加入等待隊列...');
    await new Promise(resolve => this.queue.push(resolve));
    console.log('🔒 Mutex 已鎖定（從隊列中獲得）');
  }

  unlock() {
    if (this.queue.length > 0) {
      // 如果有等待的請求，喚醒第一個
      const resolve = this.queue.shift();
      console.log('🔓 Mutex 解鎖，喚醒隊列中的下一個請求');
      resolve();
    } else {
      // 沒有等待的請求，直接解鎖
      this.locked = false;
      console.log('🔓 Mutex 已解鎖');
    }
  }

  isLocked() {
    return this.locked;
  }
}

// 全域變數
let pageCounter = 1;
let capturing = false;
const captureMutex = new Mutex(); // ✨ v2.0：使用 Mutex 取代 isProcessing
let maxPages = 10; // 預設擷取 10 頁
let captureAll = false; // 是否擷取到最後
let mergeToPdf = false; // 是否合併成 PDF
let flipDirection = 'right'; // ✨ v2.1：翻頁方向（'right' 或 'left'）
let capturedImages = []; // 儲存所有擷取的圖片 data URLs
let currentFolder = ''; // 當前擷取的資料夾名稱（帶時間戳記）

// 生成本地時間的時間戳記
function getLocalTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("Background received message:", msg.type);

  if (msg.type === "START_CAPTURE") {
    capturing = true;
    pageCounter = 1;
    captureAll = msg.captureAll || false; // 是否擷取到最後
    maxPages = msg.maxPages || 10; // 接收使用者設定的頁數，預設 10 頁
    mergeToPdf = msg.mergeToPdf || false; // 是否合併成 PDF
    flipDirection = msg.flipDirection || 'right'; // ✨ v2.1：接收翻頁方向，預設向右
    capturedImages = []; // 重置圖片陣列

    // 生成帶時間戳記的資料夾名稱（使用本地時間）
    const timestamp = getLocalTimestamp();
    currentFolder = `auto-capture-${timestamp}`;

    const directionText = flipDirection === 'left' ? '向左 ←' : '向右 →';
    if (captureAll) {
      console.log(`Starting capture, mode: 擷取到最後, Merge to PDF: ${mergeToPdf}, Flip: ${directionText}, Folder: ${currentFolder}`);
    } else {
      console.log(`Starting capture, max pages: ${maxPages}, Merge to PDF: ${mergeToPdf}, Flip: ${directionText}, Folder: ${currentFolder}`);
    }
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        const tabId = tabs[0].id;
        console.log("Attempting to send BEGIN to tab:", tabId);

        // 先嘗試發送訊息，如果失敗則手動注入 content script
        try {
          await chrome.tabs.sendMessage(tabId, { type: "BEGIN", flipDirection: flipDirection });
          console.log("BEGIN message sent successfully");
        } catch (error) {
          console.log("Content script not loaded, injecting manually...");
          try {
            // 手動注入 content script
            await chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['content.js']
            });
            console.log("Content script injected, waiting 500ms...");
            // 等待 content script 初始化
            await new Promise(resolve => setTimeout(resolve, 500));
            // 再次嘗試發送訊息
            await chrome.tabs.sendMessage(tabId, { type: "BEGIN", flipDirection: flipDirection });
            console.log("BEGIN message sent after manual injection");
          } catch (injectError) {
            console.error("Failed to inject content script:", injectError.message);
            console.error("This page may not support extensions (chrome://, edge://, etc.)");
          }
        }
      } else {
        console.error("No active tab found");
      }
    });
  }

  if (msg.type === "STOP_CAPTURE") {
    handleStopCapture(false)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch(error => {
        console.error(`❌ handleStopCapture 錯誤:`, error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (msg.type === "AUTO_STOP_CAPTURE") {
    handleStopCapture(true)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch(error => {
        console.error(`❌ handleAutoStopCapture 錯誤:`, error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (msg.type === "CAPTURE_PAGE" && capturing) {
    console.log(`📨 [v2.0] 收到 CAPTURE_PAGE 請求，Mutex 鎖定狀態 = ${captureMutex.isLocked()}`);

    // 調用獨立的異步處理函數，確保 sendResponse 正確執行
    handleCapturePage()
      .then(result => {
        console.log(`📤 handleCapturePage 完成，準備發送 response:`, result);
        sendResponse(result);
        console.log(`✅ sendResponse 已調用`);
      })
      .catch(error => {
        console.error(`❌ handleCapturePage 發生未捕獲的錯誤:`, error);
        console.error(`錯誤堆疊:`, error.stack);
        sendResponse({ ok: false, error: error.message || "未知錯誤", pageNumber: pageCounter });
      });
    return true; // 告訴 Chrome 會異步回應
  }
});

// 處理停止擷取的獨立函數
async function handleStopCapture(isAuto = false) {
  capturing = false;

  // 如果需要合併成 PDF，執行合併
  if (mergeToPdf && capturedImages.length > 0) {
    if (isAuto) {
      console.log(`已擷取到最後一頁，開始合併 ${capturedImages.length} 張圖片成 PDF`);
    } else {
      console.log(`手動停止，開始合併 ${capturedImages.length} 張圖片成 PDF`);
    }
    await generatePDF();
  } else {
    if (isAuto) {
      console.log(`已擷取到最後一頁，共擷取 ${pageCounter - 1} 頁`);
    } else {
      console.log(`手動停止，共擷取 ${pageCounter - 1} 頁`);
    }
  }
}

// ✨ v2.0 重構：獨立的異步處理函數，使用 Mutex 確保原子性
async function handleCapturePage() {
  // ✨ 使用 Mutex 鎖定，確保同時只有一個擷取操作
  await captureMutex.lock();

  console.log(`📸 [v2.0] 開始擷取第 ${pageCounter} 頁`);

  try {
    // 內部重試機制（不會增加 pageCounter 直到成功）
    const MAX_RETRIES = 5;
    let success = false;
    let lastError = null;

      for (let attempt = 0; attempt < MAX_RETRIES && !success; attempt++) {
        try {
          if (attempt > 0) {
            console.log(`重試擷取第 ${pageCounter} 頁 (嘗試 ${attempt + 1}/${MAX_RETRIES})...`);
            await new Promise(resolve => setTimeout(resolve, 800));
          }

          if (captureAll) {
            console.log(`Capturing page: ${pageCounter} (擷取到最後模式)`);
          } else {
            console.log(`Capturing page: ${pageCounter}/${maxPages}`);
          }

          // 查詢標籤頁
          let tab = null;
          for (let i = 0; i < 3; i++) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs.length > 0) {
              tab = tabs[0];
              break;
            }
            if (i < 2) await new Promise(resolve => setTimeout(resolve, 500));
          }

          if (!tab) {
            lastError = "找不到活動標籤頁（可能切換到其他標籤或視窗失去焦點）";
            console.warn(`⚠️ ${lastError}`);
            continue; // 重試
          }

          console.log(`✓ 找到標籤頁 ID: ${tab.id}, windowId: ${tab.windowId}`);

          // 擷取視窗
          let dataUrl;
          try {
            dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
              format: "png"
            });
          } catch (captureError) {
            lastError = `擷取視窗失敗: ${captureError.message}`;
            console.warn(`⚠️ ${lastError}`);
            continue; // 重試
          }

          // 裁切圖片左右空白
          dataUrl = await cropImageWhitespace(dataUrl);

          // 下載個別圖片
          const filename = `page-${String(pageCounter).padStart(3, "0")}.png`;

          // ✨ v2.0 改進：等待下載真正完成（立即檢查 + 驗證檔案大小）
          const downloadSuccess = await new Promise((resolve) => {
            chrome.downloads.download({
              url: dataUrl,
              filename: `${currentFolder}/${filename}`,
              saveAs: false,
              conflictAction: 'uniquify'
            }, async (downloadId) => {
              if (!downloadId) {
                console.error(`❌ 下載失敗: ${filename}`);
                resolve(false);
                return;
              }

              console.log(`📥 下載任務已建立: ${filename} (ID: ${downloadId})`);

              // ✨ v2.0 改進：使用輪詢方式檢查下載狀態
              const maxAttempts = 60; // 最多檢查 60 次
              const interval = 200;   // ✨ 縮短為 200ms，更快速響應（總共最多 12 秒）
              let attempts = 0;

              const checkDownloadStatus = async () => {
                attempts++;

                try {
                  const results = await chrome.downloads.search({ id: downloadId });

                  // ✨ v2.0 改進：找不到下載記錄可能表示已完成並被清理
                  if (results.length === 0) {
                    if (attempts === 1) {
                      // 第一次就找不到，可能是錯誤
                      console.error(`❌ 找不到下載 ID: ${downloadId}`);
                      resolve(false);
                      return;
                    } else {
                      // 之前能找到，現在找不到，可能是快速完成後被清理
                      console.log(`✅ 下載已完成並可能被清理: ${filename}`);
                      // 額外等待確保檔案寫入磁碟
                      await new Promise(r => setTimeout(r, 200));
                      resolve(true);
                      return;
                    }
                  }

                  const download = results[0];

                  // ✨ v2.0 改進：驗證下載狀態和檔案大小
                  if (download.state === 'complete') {
                    // 驗證檔案大小（必須 > 0）
                    if (download.bytesReceived > 0) {
                      console.log(`✅ 檔案已完全寫入磁碟: ${filename} (大小: ${(download.bytesReceived / 1024).toFixed(2)} KB, 檢查了 ${attempts} 次)`);
                      // 額外等待 200ms 確保檔案真正寫入磁碟
                      await new Promise(r => setTimeout(r, 200));
                      resolve(true);
                    } else {
                      console.error(`❌ 檔案大小為 0: ${filename}`);
                      resolve(false);
                    }
                    return;
                  } else if (download.state === 'interrupted') {
                    console.error(`❌ 下載中斷: ${filename}, 原因: ${download.error || '未知'}`);
                    resolve(false);
                    return;
                  } else if (download.state === 'in_progress') {
                    // 還在下載中
                    if (attempts >= maxAttempts) {
                      console.error(`❌ 下載超時: ${filename} (已等待 ${maxAttempts * interval / 1000} 秒)`);
                      resolve(false);
                      return;
                    }
                    // 繼續等待
                    if (attempts % 5 === 0) {
                      // 每 5 次（1 秒）輸出一次進度
                      console.log(`⏳ 下載中 (${attempts}/${maxAttempts}): ${download.bytesReceived}/${download.totalBytes || '?'} bytes`);
                    }
                    setTimeout(checkDownloadStatus, interval);
                  } else {
                    // 未知狀態，視為失敗
                    console.error(`❌ 未知下載狀態: ${download.state}`);
                    resolve(false);
                    return;
                  }
                } catch (error) {
                  console.error(`❌ 檢查下載狀態時發生錯誤:`, error);
                  resolve(false);
                }
              };

              // ✨ v2.0 關鍵改進：立即檢查（不等待），避免錯過快速完成的下載
              checkDownloadStatus();
            });
          });

          if (!downloadSuccess) {
            lastError = `下載檔案失敗: ${filename}（下載未完成或中斷）`;
            console.warn(`⚠️ ${lastError}`);
            continue; // 重試（不增加 pageCounter）
          }

          // ✨ v2.0 修正：下載成功才保存到 PDF 陣列
          // 如果需要合併成 PDF，同時將圖片存入陣列
          if (mergeToPdf) {
            // 驗證 dataUrl 有效性
            if (dataUrl && dataUrl.startsWith('data:image/')) {
              capturedImages.push(dataUrl);
              console.log(`✅ Image ${pageCounter} saved for PDF merging (total: ${capturedImages.length}, size: ${(dataUrl.length / 1024).toFixed(2)} KB)`);
            } else {
              console.error(`❌ 無法保存圖片 ${pageCounter} 到 PDF 陣列：data URL 無效`);
              console.error(`dataUrl 開頭: ${dataUrl ? dataUrl.substring(0, 50) : 'null'}`);
            }
          }

          // ✨ v2.0 關鍵修正：只有在下載完全成功後才標記成功
          success = true;

        } catch (error) {
          lastError = `執行過程發生異常: ${error.message || error.toString()}`;
          console.error(`❌ Error in attempt ${attempt + 1}:`, error);
          console.error(`錯誤詳情:`, lastError);
        }
      }

    // 檢查是否成功
    if (!success) {
      const errorDetail = lastError || "未知錯誤（無錯誤訊息記錄）";
      console.error(`❌ 擷取第 ${pageCounter} 頁失敗（已重試 ${MAX_RETRIES} 次）`);
      console.error(`錯誤原因: ${errorDetail}`);
      // ❌ 失敗不增加 pageCounter，下次重試會用同一個頁碼
      return { ok: false, error: errorDetail, pageNumber: pageCounter, retries: MAX_RETRIES };
    }

    // ✅ v2.0 關鍵修正：成功後才增加頁碼（在這裡才增加，確保下載真正完成）
    const capturedPageNumber = pageCounter;
    pageCounter++;
    console.log(`✅ 第 ${capturedPageNumber} 頁擷取成功，pageCounter 更新為 ${pageCounter}`);

    // 只有在非「擷取到最後」模式下才檢查頁數限制
    if (!captureAll && capturedPageNumber >= maxPages) {
      console.log(`已完成 ${maxPages} 頁擷取，自動停止`);
      capturing = false;

      // 如果需要合併成 PDF，執行合併
      if (mergeToPdf && capturedImages.length > 0) {
        await generatePDF();
      }

      // 通知 content script 停止
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: "STOP" }).catch((error) => {
            console.log("Content script already stopped:", error.message);
          });
        }
      });
    }

    return { ok: true, pageNumber: capturedPageNumber };
  } catch (outerError) {
    console.error(`❌ CAPTURE_PAGE 處理過程發生嚴重錯誤:`, outerError);
    console.error(`錯誤堆疊:`, outerError.stack);
    return { ok: false, error: `嚴重錯誤: ${outerError.message}`, pageNumber: pageCounter };
  } finally {
    // ✨ v2.0：使用 Mutex 解鎖，確保下一個請求可以執行
    captureMutex.unlock();
    console.log(`🏁 [v2.0] 第 ${pageCounter - 1} 頁處理完畢`);
  }
}

// 裁切圖片左右空白的函數
async function cropImageWhitespace(dataUrl) {
  try {
    // 將 data URL 轉換為 Blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    // 使用 createImageBitmap 載入圖片
    const imageBitmap = await createImageBitmap(blob);
    const width = imageBitmap.width;
    const height = imageBitmap.height;

    // 建立 OffscreenCanvas
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 繪製圖片到 canvas
    ctx.drawImage(imageBitmap, 0, 0);

    // 取得圖片像素資料
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // 設定空白判斷閾值（降低以識別更多空白）
    const WHITE_THRESHOLD = 240; // 降低閾值，更容易識別空白
    const SAMPLE_STEP = 10; // 每隔 10 個像素採樣一次，提高效率
    const CONTENT_THRESHOLD = 0.05; // 如果一列中超過 5% 的像素是內容，就認為這列有內容

    // 輔助函數：判斷一列是否有內容
    function hasContentInColumn(x) {
      let contentPixels = 0;
      let totalSamples = 0;

      // 只檢查垂直中間 80% 的區域，避免邊緣噪點
      const startY = Math.floor(height * 0.1);
      const endY = Math.floor(height * 0.9);

      for (let y = startY; y < endY; y += SAMPLE_STEP) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // 如果像素不是接近白色
        if (r < WHITE_THRESHOLD || g < WHITE_THRESHOLD || b < WHITE_THRESHOLD) {
          contentPixels++;
        }
        totalSamples++;
      }

      // 如果內容像素超過閾值，認為這列有內容
      return (contentPixels / totalSamples) > CONTENT_THRESHOLD;
    }

    // 偵測左邊界（從左往右找到第一個有內容的列）
    let leftBound = 0;
    for (let x = 0; x < width; x++) {
      if (hasContentInColumn(x)) {
        leftBound = x;
        break;
      }
    }

    // 偵測右邊界（從右往左找到第一個有內容的列）
    let rightBound = width - 1;
    for (let x = width - 1; x >= 0; x--) {
      if (hasContentInColumn(x)) {
        rightBound = x;
        break;
      }
    }

    // 增加一些邊距，避免裁切太緊（左右各保留 5 像素）
    const PADDING = 5;
    leftBound = Math.max(0, leftBound - PADDING);
    rightBound = Math.min(width - 1, rightBound + PADDING);

    // 計算裁切後的寬度
    const croppedWidth = rightBound - leftBound + 1;

    // 如果沒有需要裁切的，返回原圖
    if (leftBound === 0 && rightBound === width - 1) {
      console.log('No whitespace to crop');
      return dataUrl;
    }

    const removedLeft = leftBound;
    const removedRight = width - 1 - rightBound;
    console.log(`Cropping: removed ${removedLeft}px from left, ${removedRight}px from right, original width=${width}, cropped width=${croppedWidth}`);

    // 建立新的 canvas 用於裁切後的圖片
    const croppedCanvas = new OffscreenCanvas(croppedWidth, height);
    const croppedCtx = croppedCanvas.getContext('2d');

    // 繪製裁切後的圖片
    croppedCtx.drawImage(imageBitmap, leftBound, 0, croppedWidth, height, 0, 0, croppedWidth, height);

    // 轉換為 Blob
    const croppedBlob = await croppedCanvas.convertToBlob({ type: 'image/png' });

    // 轉換為 data URL
    const reader = new FileReader();
    return new Promise((resolve) => {
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(croppedBlob);
    });

  } catch (error) {
    console.error('Error cropping image:', error);
    return dataUrl; // 如果失敗，返回原圖
  }
}

// 生成 PDF 函數
async function generatePDF() {
  try {
    console.log(`📄 開始生成 PDF，capturedImages 長度: ${capturedImages.length}`);

    // 檢查是否有圖片
    if (!capturedImages || capturedImages.length === 0) {
      console.error('❌ 無法生成 PDF：沒有擷取到任何圖片');
      return;
    }

    // 統計有效圖片數量
    const validImages = capturedImages.filter(img => img && img.startsWith('data:image/'));
    console.log(`✅ 有效圖片數量: ${validImages.length}/${capturedImages.length}`);

    if (validImages.length === 0) {
      console.error('❌ 無法生成 PDF：沒有有效的圖片數據');
      return;
    }

    // 使用 jsPDF（importScripts 後會掛載到 self.jspdf）
    if (!self.jspdf) {
      throw new Error('jsPDF 庫未正確載入');
    }
    const { jsPDF } = self.jspdf;

    // 建立 PDF（A4 尺寸，landscape 橫式）
    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    // 加入每一張圖片
    let successCount = 0;
    for (let i = 0; i < capturedImages.length; i++) {
      try {
        const imageDataUrl = capturedImages[i];

        // 檢查圖片數據是否有效
        if (!imageDataUrl) {
          console.error(`⚠️ 跳過圖片 ${i + 1}: 數據為空`);
          continue;
        }

        if (!imageDataUrl.startsWith('data:image/')) {
          console.error(`⚠️ 跳過圖片 ${i + 1}: 不是有效的 data URL (開頭: ${imageDataUrl.substring(0, 50)}...)`);
          continue;
        }

        console.log(`Adding image ${i + 1}/${capturedImages.length} to PDF`);

        // 第一頁不需要新增頁面
        if (i > 0) {
          pdf.addPage();
        }

        // 載入圖片以取得原始尺寸
        const response = await fetch(imageDataUrl);
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);

      const imgWidth = imageBitmap.width;
      const imgHeight = imageBitmap.height;
      const imgRatio = imgWidth / imgHeight;
      const pageRatio = pageWidth / pageHeight;

      let finalWidth, finalHeight, x, y;

      // 根據圖片和頁面的比例，計算最佳縮放
      if (imgRatio > pageRatio) {
        // 圖片較寬，以寬度為基準
        finalWidth = pageWidth;
        finalHeight = pageWidth / imgRatio;
        x = 0;
        y = (pageHeight - finalHeight) / 2; // 垂直置中
      } else {
        // 圖片較高，以高度為基準
        finalHeight = pageHeight;
        finalWidth = pageHeight * imgRatio;
        x = (pageWidth - finalWidth) / 2; // 水平置中
        y = 0;
      }

        console.log(`Image ${i + 1}: original ${imgWidth}x${imgHeight}, scaled to ${finalWidth.toFixed(2)}x${finalHeight.toFixed(2)} mm`);

        // 加入圖片（保持比例，居中放置）
        pdf.addImage(
          imageDataUrl,
          'PNG',
          x,
          y,
          finalWidth,
          finalHeight,
          undefined,
          'FAST'
        );

        successCount++;
        console.log(`✅ Image ${i + 1} 已成功加入 PDF (總計: ${successCount})`);

      } catch (imageError) {
        console.error(`❌ 加入圖片 ${i + 1} 到 PDF 時發生錯誤:`, imageError);
        console.error(`錯誤詳情:`, imageError.message);
        console.error(`圖片數據長度:`, capturedImages[i]?.length || 0);
        // 繼續處理下一張圖片
      }
    }

    // 檢查是否至少有一張圖片成功加入
    if (successCount === 0) {
      console.error('❌ 無法生成 PDF：沒有任何圖片成功加入');
      return;
    }

    console.log(`📊 PDF 生成統計: 成功 ${successCount}/${capturedImages.length} 張圖片`);

    // 生成 PDF 的 data URI（在 Service Worker 中不能使用 URL.createObjectURL）
    const pdfDataUri = pdf.output('datauristring');

    // 產生檔案名稱（使用當前資料夾）
    const filename = `${currentFolder}/merged.pdf`;

    console.log(`📥 準備下載 PDF: ${filename}`);

    // 下載 PDF
    chrome.downloads.download({
      url: pdfDataUri,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (downloadId) {
        console.log(`PDF 下載成功，download ID: ${downloadId}`);
        // 清空圖片陣列
        capturedImages = [];
      } else {
        console.error('PDF 下載失敗');
      }
    });

  } catch (error) {
    console.error('生成 PDF 時發生錯誤:', error);
  }
}
