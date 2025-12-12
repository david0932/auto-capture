// 引入 jsPDF 庫
importScripts('jspdf.umd.min.js');

let pageCounter = 1;
let capturing = false;
let maxPages = 10; // 預設擷取 10 頁
let captureAll = false; // 是否擷取到最後
let mergeToPdf = false; // 是否合併成 PDF
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

chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  console.log("Background received message:", msg.type);

  if (msg.type === "START_CAPTURE") {
    capturing = true;
    pageCounter = 1;
    captureAll = msg.captureAll || false; // 是否擷取到最後
    maxPages = msg.maxPages || 10; // 接收使用者設定的頁數，預設 10 頁
    mergeToPdf = msg.mergeToPdf || false; // 是否合併成 PDF
    capturedImages = []; // 重置圖片陣列

    // 生成帶時間戳記的資料夾名稱（使用本地時間）
    const timestamp = getLocalTimestamp();
    currentFolder = `auto-capture-${timestamp}`;

    if (captureAll) {
      console.log(`Starting capture, mode: 擷取到最後, Merge to PDF: ${mergeToPdf}, Folder: ${currentFolder}, sending BEGIN to content script`);
    } else {
      console.log(`Starting capture, max pages: ${maxPages}, Merge to PDF: ${mergeToPdf}, Folder: ${currentFolder}, sending BEGIN to content script`);
    }
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        const tabId = tabs[0].id;
        console.log("Attempting to send BEGIN to tab:", tabId);

        // 先嘗試發送訊息，如果失敗則手動注入 content script
        try {
          await chrome.tabs.sendMessage(tabId, { type: "BEGIN" });
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
            await chrome.tabs.sendMessage(tabId, { type: "BEGIN" });
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
    capturing = false;

    // 如果需要合併成 PDF，執行合併
    if (mergeToPdf && capturedImages.length > 0) {
      console.log(`手動停止，開始合併 ${capturedImages.length} 張圖片成 PDF`);
      await generatePDF();
    }
  }

  if (msg.type === "CAPTURE_PAGE" && capturing) {
    if (captureAll) {
      console.log(`Capturing page: ${pageCounter} (擷取到最後模式)`);
    } else {
      console.log(`Capturing page: ${pageCounter}/${maxPages}`);
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png"
    });

    // 裁切圖片左右空白
    console.log("Cropping whitespace from image...");
    dataUrl = await cropImageWhitespace(dataUrl);

    // 下載個別圖片
    const filename = `page-${String(pageCounter).padStart(3, "0")}.png`;
    console.log("Downloading:", filename);

    chrome.downloads.download({
      url: dataUrl,
      filename: `${currentFolder}/${filename}`,  // 使用帶時間戳記的資料夾
      saveAs: false,
      conflictAction: 'uniquify'  // 如果檔案存在，自動重新命名（加上數字後綴）
    });

    // 如果需要合併成 PDF，同時將圖片存入陣列
    if (mergeToPdf) {
      capturedImages.push(dataUrl);
      console.log(`Image ${pageCounter} saved for PDF merging (total: ${capturedImages.length})`);
    }

    // 只有在非「擷取到最後」模式下才檢查頁數限制
    if (!captureAll && pageCounter >= maxPages) {
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

    pageCounter++;
    sendResponse({ ok: true });
  }

  return true;
});

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
    console.log(`開始生成 PDF，共 ${capturedImages.length} 張圖片`);

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
    for (let i = 0; i < capturedImages.length; i++) {
      console.log(`Adding image ${i + 1}/${capturedImages.length} to PDF`);

      // 第一頁不需要新增頁面
      if (i > 0) {
        pdf.addPage();
      }

      // 載入圖片以取得原始尺寸
      const response = await fetch(capturedImages[i]);
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
        capturedImages[i],
        'PNG',
        x,
        y,
        finalWidth,
        finalHeight,
        undefined,
        'FAST'
      );
    }

    // 生成 PDF 的 data URI（在 Service Worker 中不能使用 URL.createObjectURL）
    const pdfDataUri = pdf.output('datauristring');

    // 產生檔案名稱（使用當前資料夾）
    const filename = `${currentFolder}/merged.pdf`;

    console.log(`Downloading PDF: ${filename}`);

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
