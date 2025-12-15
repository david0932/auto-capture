document.addEventListener("DOMContentLoaded", () => {

  const pageCountInput = document.getElementById("pageCount");
  const captureAllCheckbox = document.getElementById("captureAll");
  const mergeToPdfCheckbox = document.getElementById("mergeToPdf");

  // 監聽「擷取到最後」checkbox 的變化
  captureAllCheckbox.addEventListener("change", () => {
    if (captureAllCheckbox.checked) {
      pageCountInput.disabled = true;
      pageCountInput.style.opacity = "0.5";
    } else {
      pageCountInput.disabled = false;
      pageCountInput.style.opacity = "1";
    }
  });

  document.getElementById("start").addEventListener("click", () => {
    console.log("Start button clicked");

    const captureAll = captureAllCheckbox.checked;
    const mergeToPdf = mergeToPdfCheckbox.checked;

    // 取得翻頁方向
    const flipDirection = document.querySelector('input[name="flipDirection"]:checked').value;
    console.log("Flip direction:", flipDirection);

    if (captureAll) {
      // 擷取到最後模式
      console.log("Capture mode: Until end, Merge to PDF:", mergeToPdf, ", Flip direction:", flipDirection);
      chrome.runtime.sendMessage({
        type: "START_CAPTURE",
        captureAll: true,
        mergeToPdf: mergeToPdf,
        flipDirection: flipDirection
      });
    } else {
      // 指定頁數模式
      const maxPages = parseInt(pageCountInput.value) || 10; // 預設 10 頁

      if (maxPages < 1) {
        alert("請輸入有效的頁數（至少 1 頁）");
        return;
      }

      console.log("Capture mode: Max pages:", maxPages, ", Merge to PDF:", mergeToPdf, ", Flip direction:", flipDirection);
      chrome.runtime.sendMessage({
        type: "START_CAPTURE",
        maxPages: maxPages,
        mergeToPdf: mergeToPdf,
        flipDirection: flipDirection
      });
    }
  });

  document.getElementById("stop").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "STOP" }).catch((error) => {
          console.log("Content script not ready yet:", error.message);
        });
      }
    });
  });

});
