/*
 * 코팅 설비 생산일지 대시보드
 * ------------------------------------------------------------
 * 이 파일은 별도의 빌드 도구나 라이브러리 없이 브라우저에서 실행됩니다.
 * 파일 선택 -> CSV 읽기 -> 생산 지표 계산 -> 차트와 전체 목록 표시 순서로 동작합니다.
 *
 * CSV 원본은 예시와 같이 CP949(한글 Windows)로 저장될 수 있으므로,
 * 먼저 UTF-8로 디코딩을 시도하고 실패하는 경우 브라우저의 euc-kr 디코더를 사용합니다.
 * 데이터는 브라우저 메모리에서만 처리하며 외부 서버로 전송하지 않습니다.
 */

"use strict";

// HTML의 각 대시보드 영역을 스크립트 시작 시 한 번만 찾아 두어 재사용합니다.
const fileInput = document.getElementById("csv-file");
const fileNameLabel = document.getElementById("file-name");
const messageElement = document.getElementById("message");
const singleFileTab = document.getElementById("single-file-tab");
const allDataTab = document.getElementById("all-data-tab");
const singleFileView = document.getElementById("single-file-view");
const allDataView = document.getElementById("all-data-view");
const connectDataFolderButton = document.getElementById("connect-data-folder");
const directoryFilesInput = document.getElementById("directory-files");
const directoryFallbackLabel = document.getElementById("directory-fallback-label");
const refreshAllDataButton = document.getElementById("refresh-all-data");
const allDataStatus = document.getElementById("all-data-status");
const allDataFiles = document.getElementById("all-data-files");
const equipmentChart = document.getElementById("equipment-chart");
const dailyChart = document.getElementById("daily-chart");
const modelChart = document.getElementById("model-chart");
const equipmentTimeChart = document.getElementById("equipment-time-chart");
const ngTableHead = document.getElementById("ng-table-head");
const ngTableBody = document.getElementById("ng-table-body");
const ngTableCount = document.getElementById("ng-table-count");
const tableHead = document.getElementById("table-head");
const tableBody = document.getElementById("table-body");
const tableCount = document.getElementById("table-count");

// 단일 파일 화면과 Product_data 전체 화면은 같은 집계·차트·표 함수를 사용하되,
// 각 화면이 갱신할 HTML 요소만 이 설정으로 분리합니다.
const SINGLE_DASHBOARD_TARGETS = {
  summaryIds: {
    totalRolls: "total-rolls",
    defectRate: "defect-rate",
    operationRate: "operation-rate",
    totalLoss: "total-loss"
  },
  charts: {
    equipment: equipmentChart,
    daily: dailyChart,
    model: modelChart,
    equipmentTime: equipmentTimeChart
  },
  tables: {
    ng: { head: ngTableHead, body: ngTableBody, count: ngTableCount },
    all: { head: tableHead, body: tableBody, count: tableCount }
  },
  includeSourceFile: false
};

const ALL_DATA_DASHBOARD_TARGETS = {
  summaryIds: {
    totalRolls: "all-total-rolls",
    defectRate: "all-defect-rate",
    operationRate: "all-operation-rate",
    totalLoss: "all-total-loss"
  },
  charts: {
    equipment: document.getElementById("all-equipment-chart"),
    daily: document.getElementById("all-daily-chart"),
    model: document.getElementById("all-model-chart"),
    equipmentTime: document.getElementById("all-equipment-time-chart")
  },
  tables: {
    ng: {
      head: document.getElementById("all-ng-table-head"),
      body: document.getElementById("all-ng-table-body"),
      count: document.getElementById("all-ng-table-count")
    },
    all: {
      head: document.getElementById("all-table-head"),
      body: document.getElementById("all-table-body"),
      count: document.getElementById("all-table-count")
    }
  },
  includeSourceFile: true
};

// 파일 핸들을 IndexedDB에 보관하면 같은 브라우저에서 다음에 열 때 폴더를 다시 고르지 않아도 됩니다.
const DIRECTORY_HANDLE_DATABASE = "production-dashboard";
const DIRECTORY_HANDLE_STORE = "settings";
const DIRECTORY_HANDLE_KEY = "product-data-directory";
const DIRECTORY_REFRESH_INTERVAL_MS = 30000;
let productDataDirectoryHandle = null;
let directoryPollingTimer = null;
let directoryRefreshInProgress = false;
let lastDirectorySignature = "";
let selectedDirectoryFiles = null;

// 생산일지의 주요 데이터 열을 한국어 헤더 별칭으로 찾습니다.
// 파일마다 열 순서가 다른 경우에도 이름을 우선 사용하고, 모델 열만 없는 기존 CSV는
// 명시적인 "생산모델 없음" 값으로 처리하여 나머지 차트와 표가 계속 표시되도록 합니다.
const COLUMN_ALIASES = {
  date: ["생산일자", "일자", "날짜", "작업일자"],
  equipment: ["설비명", "설비", "기계명", "설비번호"],
  model: ["생산모델", "제품모델", "모델명", "제품명", "모델", "품명"],
  productionTime: ["생산시간_분", "생산시간", "가동시간_분", "가동시간"],
  lossTime: ["로스시간_분", "로스시간", "손실시간_분", "손실시간"],
  judgment: ["판정", "검사판정", "품질판정", "결과"]
};

// 사용자가 파일을 다시 선택하면 이전 데이터 대신 새 파일을 분석합니다.
fileInput.addEventListener("change", handleFileSelection);
singleFileTab.addEventListener("click", () => setActiveDashboard("single"));
allDataTab.addEventListener("click", () => {
  setActiveDashboard("all");
  refreshAllData({ requestPermission: true }).catch(reportDirectoryError);
});
connectDataFolderButton.addEventListener("click", handleDirectoryConnection);
directoryFilesInput.addEventListener("change", handleFallbackDirectorySelection);
refreshAllDataButton.addEventListener("click", () => {
  if (productDataDirectoryHandle) {
    refreshAllData({ requestPermission: true }).catch(reportDirectoryError);
  } else if (directoryFilesInput.files && directoryFilesInput.files.length > 0) {
    handleFallbackDirectorySelection();
  } else {
    directoryFilesInput.click();
  }
});

initializeDirectoryAccess();

/**
 * 선택한 CSV 파일을 읽고 대시보드 전체를 갱신합니다.
 * 읽기, 문자 디코딩, CSV 구조 오류는 사용자에게 알리고 콘솔에도 자세히 기록합니다.
 */
async function handleFileSelection() {
  const file = fileInput.files && fileInput.files[0];

  // 파일 선택 창에서 취소를 누르면 현재 화면의 대시보드는 그대로 둡니다.
  if (!file) {
    return;
  }

  fileNameLabel.textContent = file.name;
  setMessage("파일을 읽고 있습니다.", false);

  try {
    const text = await readCsvFile(file);
    const parsed = parseCsv(text);

    if (parsed.rows.length === 0) {
      throw new Error("CSV에 분석할 생산 데이터 행이 없습니다.");
    }

    const columnIndexes = findColumnIndexes(parsed.headers);
    const records = parsed.rows.map((row, index) =>
      createRecord(row, parsed.headers, columnIndexes, index)
    );

    renderDashboard(records, parsed.headers);
    setMessage(
      `${file.name} 파일에서 ${formatInteger(records.length)}건의 생산 데이터를 불러왔습니다.`,
      false
    );
  } catch (error) {
    console.error("CSV 대시보드를 표시하지 못했습니다.", error);
    setMessage(`파일을 읽지 못했습니다: ${error.message}`, true);
  }
}

/**
 * 지원 브라우저에서는 사용자가 고른 폴더 핸들을 보관하고, 미지원 브라우저에서는
 * 브라우저 표준 폴더 업로드 입력을 안내해 정적 웹페이지에서도 데이터를 읽게 합니다.
 */
async function initializeDirectoryAccess() {
  const supportsFolderHandle = typeof window.showDirectoryPicker === "function";
  connectDataFolderButton.hidden = !supportsFolderHandle;
  directoryFallbackLabel.hidden = supportsFolderHandle;

  if (!supportsFolderHandle) {
    setAllDataStatus(
      "이 브라우저에서는 폴더 자동 감지를 지원하지 않습니다. Product_data 폴더를 선택한 뒤 파일이 추가되면 다시 폴더를 선택해 새로고침해 주세요.",
      false
    );
    return;
  }

  try {
    productDataDirectoryHandle = await readSavedDirectoryHandle();
    if (!productDataDirectoryHandle) {
      return;
    }

    const permission = await productDataDirectoryHandle.queryPermission({ mode: "read" });
    if (permission === "granted") {
      refreshAllData({ requestPermission: false }).catch(reportDirectoryError);
    } else {
      setAllDataStatus(
        "이전에 연결한 폴더가 있습니다. 전체 대시보드 탭을 열어 읽기 권한을 허용하면 최신 데이터를 불러옵니다.",
        false
      );
    }
  } catch (error) {
    console.error("저장된 Product_data 폴더 연결 정보를 불러오지 못했습니다.", error);
    setAllDataStatus("저장된 폴더 연결을 확인하지 못했습니다. Product_data 폴더를 다시 연결해 주세요.", true);
  }
}

/**
 * 사용자가 직접 누른 버튼에서 폴더 선택기를 열어 Product_data 폴더 권한을 얻습니다.
 */
async function handleDirectoryConnection() {
  try {
    productDataDirectoryHandle = await window.showDirectoryPicker({ mode: "read" });
    selectedDirectoryFiles = null;
    lastDirectorySignature = "";
    refreshAllDataButton.disabled = false;
    let handleSaved = true;
    try {
      await saveDirectoryHandle(productDataDirectoryHandle);
    } catch (storageError) {
      console.error("폴더 연결 정보를 다음 방문을 위해 저장하지 못했습니다.", storageError);
      handleSaved = false;
    }
    await refreshAllData({ requestPermission: true });
    if (!handleSaved) {
      const currentStatus = allDataStatus.textContent;
      const isError = allDataStatus.classList.contains("error");
      setAllDataStatus(
        `${currentStatus} 브라우저 저장소에 연결 정보를 보관하지 못해 다음 방문에는 폴더를 다시 선택해야 합니다.`,
        isError
      );
    }
    if (!allDataView.hidden) {
      startDirectoryPolling();
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    reportDirectoryError(error);
  }
}

/**
 * 폴더 접근 API가 없는 브라우저에서 사용자가 지정한 Product_data의 CSV 파일들을 기억합니다.
 * 보안 정책상 이 대체 방식은 폴더 변경을 실시간 감시할 수 없어 사용자가 다시 선택해야 합니다.
 */
async function handleFallbackDirectorySelection() {
  const files = Array.from(directoryFilesInput.files || [])
    .filter((file) => file.name.toLocaleLowerCase().endsWith(".csv"))
    .sort((first, second) => first.webkitRelativePath.localeCompare(second.webkitRelativePath, "ko"));

  if (files.length === 0) {
    setAllDataStatus("선택한 폴더에서 CSV 파일을 찾을 수 없습니다.", true);
    return;
  }

  selectedDirectoryFiles = files;
  productDataDirectoryHandle = null;
  lastDirectorySignature = "";
  refreshAllDataButton.disabled = false;
  directoryFilesInput.value = "";
  try {
    await renderAllDirectoryFiles(files);
    setAllDataStatus(
      `${formatInteger(files.length)}개 CSV 파일을 불러왔습니다. 새 CSV가 추가되면 '지금 새로고침'을 눌러 폴더를 다시 선택해 주세요.`,
      false
    );
  } catch (error) {
    reportDirectoryError(error);
  }
}

/**
 * 폴더를 선택해 둔 동안 변경·추가·삭제를 주기적으로 확인합니다.
 * 브라우저 탭이 보이고 전체 대시보드가 활성화된 동안에만 타이머를 실행합니다.
 */
function startDirectoryPolling() {
  if (!productDataDirectoryHandle || directoryPollingTimer !== null) {
    return;
  }

  directoryPollingTimer = window.setInterval(() => {
    if (document.hidden || allDataView.hidden) {
      return;
    }
    refreshAllData({ requestPermission: false }).catch(reportDirectoryError);
  }, DIRECTORY_REFRESH_INTERVAL_MS);
}

/**
 * 탭 전환 시 백그라운드 확인을 중지해 화면을 보지 않는 동안 불필요한 파일 읽기를 막습니다.
 */
function stopDirectoryPolling() {
  if (directoryPollingTimer !== null) {
    window.clearInterval(directoryPollingTimer);
    directoryPollingTimer = null;
  }
}

/**
 * 탭 상태, 접근성 선택 상태, 자동 새로고침 타이머를 일관되게 바꿉니다.
 */
function setActiveDashboard(activeTab) {
  const showAllData = activeTab === "all";
  singleFileTab.classList.toggle("active", !showAllData);
  allDataTab.classList.toggle("active", showAllData);
  singleFileTab.setAttribute("aria-selected", String(!showAllData));
  allDataTab.setAttribute("aria-selected", String(showAllData));
  singleFileView.hidden = showAllData;
  allDataView.hidden = !showAllData;

  if (showAllData && productDataDirectoryHandle) {
    startDirectoryPolling();
  } else {
    stopDirectoryPolling();
  }
}

/**
 * 폴더 핸들 권한을 확인한 뒤 변경 여부가 있는 CSV 집합만 다시 분석합니다.
 * 동일한 이름·크기·수정 시각이면 데이터를 다시 파싱하거나 DOM을 다시 그리지 않습니다.
 */
async function refreshAllData(options) {
  if (directoryRefreshInProgress) {
    return;
  }

  if (!productDataDirectoryHandle) {
    if (selectedDirectoryFiles) {
      await renderAllDirectoryFiles(selectedDirectoryFiles);
      return;
    }
    setAllDataStatus("전체 CSV를 불러오려면 Product_data 폴더를 연결해 주세요.", false);
    return;
  }

  directoryRefreshInProgress = true;
  try {
    let permission = await productDataDirectoryHandle.queryPermission({ mode: "read" });
    if (permission !== "granted" && options.requestPermission) {
      permission = await productDataDirectoryHandle.requestPermission({ mode: "read" });
    }
    if (permission !== "granted") {
      setAllDataStatus("폴더 읽기 권한이 필요합니다. 'Product_data 폴더 연결'을 눌러 폴더를 다시 선택해 주세요.", true);
      return;
    }

    const files = await collectCsvFiles(productDataDirectoryHandle);
    if (files.length === 0) {
      lastDirectorySignature = "";
      renderDashboard([], [], ALL_DATA_DASHBOARD_TARGETS);
      allDataFiles.textContent = "분석 가능한 CSV 파일이 없습니다.";
      setAllDataStatus("연결한 폴더 안에 CSV 파일이 없습니다. Product_data 폴더를 선택했는지 확인해 주세요.", true);
      return;
    }

    const signature = files
      .map(({ path, file }) => `${path}:${file.size}:${file.lastModified}`)
      .join("|");
    if (signature === lastDirectorySignature) {
      return;
    }

    await renderAllDirectoryFiles(files);
    lastDirectorySignature = signature;
    setAllDataStatus(
      `${formatInteger(files.length)}개 CSV 파일의 ${formatInteger(
        ALL_DATA_DASHBOARD_TARGETS.tables.all.body.children.length
      )}건 데이터를 불러왔습니다. 새 파일과 수정 사항을 30초마다 확인합니다.`,
      false
    );
    startDirectoryPolling();
  } finally {
    directoryRefreshInProgress = false;
  }
}

/**
 * 선택한 폴더와 하위 폴더를 순회해 확장자가 CSV인 모든 일반 파일을 경로순으로 돌려줍니다.
 */
async function collectCsvFiles(directoryHandle, parentPath = "") {
  const files = [];
  for await (const [name, entry] of directoryHandle.entries()) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    if (entry.kind === "directory") {
      files.push(...await collectCsvFiles(entry, path));
    } else if (name.toLocaleLowerCase().endsWith(".csv")) {
      files.push({ path, file: await entry.getFile() });
    }
  }
  return files.sort((first, second) => first.path.localeCompare(second.path, "ko"));
}

/**
 * 여러 CSV의 열 순서가 달라도 열 이름을 기준으로 한 공통 레코드 집합을 만듭니다.
 * 한 파일이라도 읽거나 분석할 수 없으면 파일명을 오류에 포함해 전체 로드를 중단합니다.
 */
async function renderAllDirectoryFiles(files) {
  const normalizedFiles = files.map((entry) => entry.file
    ? { file: entry.file, sourcePath: entry.path }
    : { file: entry, sourcePath: entry.sourcePath || entry.webkitRelativePath || entry.name });
  const parsedFiles = await Promise.all(normalizedFiles.map(async ({ file, sourcePath }) => {
    try {
      const parsed = parseCsv(await readCsvFile(file));
      if (parsed.rows.length === 0) {
        throw new Error("생산 데이터 행이 없습니다.");
      }
      return { file, sourcePath, parsed, indexes: findColumnIndexes(parsed.headers) };
    } catch (error) {
      throw new Error(`${sourcePath}: ${error.message}`);
    }
  }));

  const headers = [];
  const normalizedHeaders = new Set();
  parsedFiles.forEach(({ parsed }) => {
    parsed.headers.forEach((header) => {
      const normalized = normalizeHeader(header);
      if (!normalizedHeaders.has(normalized)) {
        normalizedHeaders.add(normalized);
        headers.push(header);
      }
    });
  });

  const records = [];
  parsedFiles.forEach(({ sourcePath, parsed, indexes }) => {
    parsed.rows.forEach((row, rowIndex) => {
      const record = createRecord(row, parsed.headers, indexes, rowIndex);
      const valuesByHeader = new Map(parsed.headers.map((header, index) => [
        normalizeHeader(header),
        record.values[index]
      ]));
      record.values = headers.map((header) => valuesByHeader.get(normalizeHeader(header)) || "");
      record.sourceFile = sourcePath;
      records.push(record);
    });
  });

  renderDashboard(records, headers, ALL_DATA_DASHBOARD_TARGETS);
  allDataFiles.textContent = `분석 파일 (${formatInteger(parsedFiles.length)}개): ${parsedFiles
    .map(({ sourcePath }) => sourcePath)
    .join(" · ")}`;
}

/**
 * 저장된 폴더 연결 오류를 화면에 알리고 콘솔에 원인을 남깁니다.
 */
function reportDirectoryError(error) {
  console.error("Product_data 전체 대시보드를 갱신하지 못했습니다.", error);
  setAllDataStatus(`전체 대시보드를 갱신하지 못했습니다: ${error.message}`, true);
}

/**
 * 전체 대시보드 전용 안내 문구의 오류 색상과 상태 역할을 관리합니다.
 */
function setAllDataStatus(message, isError) {
  allDataStatus.textContent = message;
  allDataStatus.classList.toggle("error", isError);
  allDataStatus.setAttribute("role", isError ? "alert" : "status");
}

/**
 * 브라우저 재시작 후에도 폴더 핸들을 복구할 수 있도록 IndexedDB를 엽니다.
 */
function openDirectoryHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DIRECTORY_HANDLE_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DIRECTORY_HANDLE_STORE)) {
        database.createObjectStore(DIRECTORY_HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("브라우저 저장소를 열지 못했습니다."));
  });
}

/**
 * 선택한 폴더 핸들을 브라우저 로컬 저장소에 기록합니다.
 */
async function saveDirectoryHandle(handle) {
  const database = await openDirectoryHandleDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(DIRECTORY_HANDLE_STORE, "readwrite");
    transaction.objectStore(DIRECTORY_HANDLE_STORE).put(handle, DIRECTORY_HANDLE_KEY);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("폴더 연결 정보를 저장하지 못했습니다."));
    transaction.onabort = () => reject(transaction.error || new Error("폴더 연결 정보 저장이 취소되었습니다."));
  });
  database.close();
}

/**
 * 이전에 저장한 폴더 핸들을 브라우저 로컬 저장소에서 불러옵니다.
 */
async function readSavedDirectoryHandle() {
  const database = await openDirectoryHandleDatabase();
  const handle = await new Promise((resolve, reject) => {
    const transaction = database.transaction(DIRECTORY_HANDLE_STORE, "readonly");
    const request = transaction.objectStore(DIRECTORY_HANDLE_STORE).get(DIRECTORY_HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("저장된 폴더 연결 정보를 읽지 못했습니다."));
  });
  database.close();
  return handle;
}

/**
 * 파일 원본의 바이트를 읽어 텍스트로 디코딩합니다.
 * UTF-8 BOM은 TextDecoder가 제거하며, UTF-8이 아닌 샘플 파일은 CP949로 처리합니다.
 * UTF-8 디코딩을 fatal 모드로 하여 손상된 바이트를 정상 텍스트인 것처럼 넘기지 않습니다.
 */
async function readCsvFile(file) {
  const bytes = await file.arrayBuffer();

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (utf8Error) {
    try {
      return new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
    } catch (cp949Error) {
      throw new Error("UTF-8 또는 한글 Windows(CP949) CSV 파일인지 확인해 주세요.");
    }
  }
}

/**
 * CSV 텍스트를 헤더와 행 배열로 나눕니다.
 * 쉼표가 들어간 인용 문자열, 큰따옴표 두 번으로 표현한 이스케이프,
 * 셀 안 줄바꿈도 처리하므로 단순 split(',')에서 발생하는 열 밀림을 방지합니다.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"') {
      // 인용 셀 안의 ""는 값에 포함되는 큰따옴표 한 글자입니다.
      if (insideQuotes && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (character === "," && !insideQuotes) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !insideQuotes) {
      // Windows 줄바꿈(CRLF)은 한 번에 소비하여 빈 행이 끼지 않게 합니다.
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      addNonEmptyRow(rows, row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (insideQuotes) {
    throw new Error("CSV 안의 큰따옴표가 닫히지 않았습니다.");
  }

  // 파일 끝에 줄바꿈이 없더라도 마지막 데이터 행을 빠뜨리지 않습니다.
  row.push(cell);
  addNonEmptyRow(rows, row);

  if (rows.length < 2) {
    throw new Error("헤더와 생산 데이터가 포함된 CSV 파일을 선택해 주세요.");
  }

  const headers = rows[0].map((header, index) => {
    const cleaned = header.trim().replace(/^\uFEFF/, "");
    return cleaned || `열 ${index + 1}`;
  });

  return {
    headers,
    rows: rows.slice(1).map((dataRow) => {
      // CSV의 행마다 열 개수가 다를 경우에도 표의 열 수를 헤더와 맞춥니다.
      return headers.map((unusedHeader, index) => (dataRow[index] || "").trim());
    })
  };
}

/**
 * 값이 전부 비어 있는 줄은 CSV의 끝이나 중간에 있어도 데이터 행에서 제외합니다.
 */
function addNonEmptyRow(rows, row) {
  if (row.some((value) => value.trim() !== "")) {
    rows.push(row);
  }
}

/**
 * 한글 헤더에서 필요한 열을 우선 찾고, 이름을 찾을 수 없는 경우에는
 * 제공된 예시 CSV의 표준 열 위치를 사용합니다.
 */
function findColumnIndexes(headers) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const findIndex = (aliases, fallbackIndex) => {
    const aliasSet = aliases.map(normalizeHeader);
    const foundIndex = normalizedHeaders.findIndex((header) => aliasSet.includes(header));
    return foundIndex >= 0 ? foundIndex : fallbackIndex;
  };

  const indexes = {
    date: findIndex(COLUMN_ALIASES.date, 0),
    equipment: findIndex(COLUMN_ALIASES.equipment, 1),
    model: findIndex(COLUMN_ALIASES.model, -1),
    productionTime: findIndex(COLUMN_ALIASES.productionTime, 10),
    lossTime: findIndex(COLUMN_ALIASES.lossTime, 11),
    judgment: findIndex(COLUMN_ALIASES.judgment, 12)
  };

  // 일자와 설비명이 없으면 샘플 CSV 위치에도 유효한 값이 있는지 확인합니다.
  if (indexes.date >= headers.length || indexes.equipment >= headers.length) {
    throw new Error("CSV에서 생산일자와 설비명 열을 찾을 수 없습니다.");
  }

  return indexes;
}

/**
 * 헤더 이름의 공백과 대소문자 차이를 무시해 CSV 열 이름을 비교합니다.
 */
function normalizeHeader(value) {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase();
}

/**
 * 한 줄의 셀 데이터로 대시보드 계산에 사용할 레코드를 만듭니다.
 * 빈 숫자는 0분으로 계산하되, 사용자가 보는 원본 표에는 CSV 셀 값을 그대로 표시합니다.
 */
function createRecord(row, headers, indexes, rowIndex) {
  const values = headers.map((unusedHeader, index) => row[index] || "");
  const productionTime = parseNumber(row[indexes.productionTime]);
  const lossTime = parseNumber(row[indexes.lossTime]);

  return {
    values,
    date: (row[indexes.date] || "").trim() || "날짜 미상",
    equipment: (row[indexes.equipment] || "").trim() || "설비 미상",
    model: indexes.model < 0 ? "생산모델 없음" : (row[indexes.model] || "").trim() || "모델 미상",
    productionTime,
    lossTime,
    judgment: (row[indexes.judgment] || "").trim().toLocaleUpperCase(),
    rowNumber: rowIndex + 1
  };
}

/**
 * 시간 열의 숫자를 안전하게 변환합니다.
 * 숫자에 천 단위 구분 쉼표가 포함된 경우를 지원하며, 비어 있거나 숫자가 아니면 0을 사용합니다.
 */
function parseNumber(value) {
  const normalized = (value || "").replace(/,/g, "").trim();
  if (normalized === "") {
    return 0;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 업로드된 동일한 레코드 집합으로 요약, 네 개 차트, NG 상세 표, 전체 표를 갱신합니다.
 */
function renderDashboard(records, headers, targets = SINGLE_DASHBOARD_TARGETS) {
  renderSummary(records, targets.summaryIds);
  renderChart(targets.charts.equipment, toSingleSeries(aggregateCounts(records, "equipment", "asc")), [
    { label: "롤 수", color: "#356ae6" }
  ]);
  renderChart(targets.charts.daily, toSingleSeries(aggregateCounts(records, "date", "asc")), [
    { label: "롤 수", color: "#17a782" }
  ]);
  renderChart(targets.charts.model, toSingleSeries(aggregateCounts(records, "model", "desc")), [
    { label: "롤 수", color: "#8b63d9" }
  ]);
  renderChart(targets.charts.equipmentTime, aggregateEquipmentTimes(records), [
    { label: "생산 시간", color: "#356ae6" },
    { label: "로스 시간", color: "#e05b73" }
  ]);
  renderTable(records.filter((record) => record.judgment === "NG"), headers, targets.tables.ng, targets.includeSourceFile);
  renderTable(records, headers, targets.tables.all, targets.includeSourceFile);
}

/**
 * 생산 건수와 품질·시간 지표를 합산하여 요약 카드를 채웁니다.
 * 불량률 = NG 롤 수 / 전체 롤 수 * 100
 * 가동률 = 생산시간 합계 / (생산시간 합계 + 로스시간 합계) * 100
 */
function renderSummary(records, summaryIds) {
  const ngRolls = records.filter((record) => record.judgment === "NG").length;
  const productionMinutes = records.reduce(
    (total, record) => total + record.productionTime,
    0
  );
  const lossMinutes = records.reduce((total, record) => total + record.lossTime, 0);
  const totalTime = productionMinutes + lossMinutes;
  const defectRate = records.length === 0 ? 0 : (ngRolls / records.length) * 100;
  const operationRate = totalTime === 0 ? 0 : (productionMinutes / totalTime) * 100;

  document.getElementById(summaryIds.totalRolls).textContent = formatInteger(records.length);
  document.getElementById(summaryIds.defectRate).textContent = `${formatOneDecimal(defectRate)}%`;
  document.getElementById(summaryIds.operationRate).textContent = `${formatOneDecimal(operationRate)}%`;
  document.getElementById(summaryIds.totalLoss).textContent = `${formatOneDecimal(lossMinutes)}분`;
}

/**
 * 지정한 항목(설비, 날짜, 모델)별 롤 수를 정렬 순서에 맞춰 집계합니다.
 */
function aggregateCounts(records, key, order) {
  const counts = new Map();

  records.forEach((record) => {
    counts.set(record[key], (counts.get(record[key]) || 0) + 1);
  });

  return Array.from(counts, ([label, count]) => ({ label, count })).sort((first, second) => {
    if (order === "desc") {
      return second.count - first.count || first.label.localeCompare(second.label, "ko");
    }
    return first.label.localeCompare(second.label, "ko", { numeric: true });
  });
}

/**
 * 롤 수 집계를 여러 값이 있는 공통 차트 형식으로 변환합니다.
 * 공통 형식을 사용하면 롤 수 차트와 시간 비교 차트가 같은 축·레이블 로직을 공유합니다.
 */
function toSingleSeries(items) {
  return items.map((item) => ({ label: item.label, values: [item.count] }));
}

/**
 * 설비별 생산시간과 로스시간을 분 단위로 각각 합산합니다.
 * 각 설비는 CSV에 나온 순서와 무관하게 생산시간이 긴 순서로 표시합니다.
 */
function aggregateEquipmentTimes(records) {
  const totals = new Map();
  records.forEach((record) => {
    const current = totals.get(record.equipment) || [0, 0];
    current[0] += record.productionTime;
    current[1] += record.lossTime;
    totals.set(record.equipment, current);
  });

  return Array.from(totals, ([label, values]) => ({ label, values }))
    .sort((first, second) => second.values[0] - first.values[0] ||
      first.label.localeCompare(second.label, "ko"));
}

/**
 * 모든 차트는 SVG로 그려 화면 폭에 맞추며, 내부 스크롤 영역을 만들지 않습니다.
 * 항목이 적으면 비교하기 쉬운 세로 막대, 항목이 많으면 한 화면에 담기 쉬운 꺾은선으로
 * 자동 전환하고, 모든 막대나 데이터 점 위에 실제 값을 표시합니다.
 */
function renderChart(container, items, series) {
  container.replaceChildren();

  if (items.length === 0) {
    container.append(createEmptyState("표시할 생산 데이터가 없습니다."));
    return;
  }

  const namespace = "http://www.w3.org/2000/svg";
  const width = 960;
  const height = 360;
  const margin = { top: 48, right: 20, bottom: 112, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const plotBottom = margin.top + plotHeight;
  const maximum = items.reduce(
    (largest, item) => item.values.reduce((itemLargest, value) => Math.max(itemLargest, value), largest),
    1
  );
  const dense = items.length > 18;
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${items.length}개 항목의 ${series.map((entry) => entry.label).join(", ")} 차트`);
  svg.classList.add("chart-svg");

  // 기준선을 두어 수치 비교가 쉽도록 하고, 축의 숫자도 현재 데이터 범위에 맞춥니다.
  for (let step = 0; step <= 4; step += 1) {
    const y = margin.top + (plotHeight * step) / 4;
    const gridLine = document.createElementNS(namespace, "line");
    gridLine.setAttribute("x1", margin.left);
    gridLine.setAttribute("x2", width - margin.right);
    gridLine.setAttribute("y1", y);
    gridLine.setAttribute("y2", y);
    gridLine.classList.add("chart-gridline");
    svg.append(gridLine);

    const axisLabel = document.createElementNS(namespace, "text");
    axisLabel.setAttribute("x", margin.left - 8);
    axisLabel.setAttribute("y", y + 3);
    axisLabel.setAttribute("text-anchor", "end");
    axisLabel.classList.add("chart-axis-label");
    axisLabel.textContent = formatChartValue((maximum * (4 - step)) / 4);
    svg.append(axisLabel);
  }

  // 차트 위쪽의 범례는 다중 계열(생산시간·로스시간)에서도 색상 의미를 분명히 합니다.
  let legendX = margin.left;
  series.forEach((entry) => {
    const swatch = document.createElementNS(namespace, "rect");
    swatch.setAttribute("x", legendX);
    swatch.setAttribute("y", 15);
    swatch.setAttribute("width", 9);
    swatch.setAttribute("height", 9);
    swatch.setAttribute("rx", 2);
    swatch.setAttribute("fill", entry.color);
    svg.append(swatch);

    const legendText = document.createElementNS(namespace, "text");
    legendText.setAttribute("x", legendX + 14);
    legendText.setAttribute("y", 24);
    legendText.classList.add("chart-legend-label");
    legendText.textContent = entry.label;
    svg.append(legendText);
    legendX += 85;
  });

  const groupWidth = plotWidth / items.length;
  if (dense) {
    // 날짜 등 항목이 많을 때 막대 대신 선과 점으로 바꾸어 한 화면에 모든 항목을 표시합니다.
    series.forEach((entry, seriesIndex) => {
      const points = items.map((item, itemIndex) => {
        const x = margin.left + groupWidth * (itemIndex + 0.5);
        const y = plotBottom - (item.values[seriesIndex] / maximum) * plotHeight;
        return { x, y, value: item.values[seriesIndex], item };
      });
      const path = document.createElementNS(namespace, "polyline");
      path.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", entry.color);
      path.setAttribute("stroke-width", series.length > 1 ? "2" : "2.5");
      path.setAttribute("stroke-linejoin", "round");
      path.classList.add("chart-line");
      svg.append(path);

      points.forEach((point) => {
        const dot = document.createElementNS(namespace, "circle");
        dot.setAttribute("cx", point.x);
        dot.setAttribute("cy", point.y);
        dot.setAttribute("r", items.length > 90 ? "1.8" : "3");
        dot.setAttribute("fill", entry.color);
        const tooltip = document.createElementNS(namespace, "title");
        tooltip.textContent = `${point.item.label} · ${entry.label}: ${formatChartValue(point.value)}`;
        dot.append(tooltip);
        svg.append(dot);

        const valueLabel = document.createElementNS(namespace, "text");
        valueLabel.setAttribute("x", point.x);
        valueLabel.setAttribute("y", Math.max(margin.top - 5, point.y - 7));
        valueLabel.setAttribute("text-anchor", "middle");
        valueLabel.classList.add("chart-value-label", "dense-value-label");
        valueLabel.textContent = formatChartValue(point.value);
        svg.append(valueLabel);
      });
    });
  } else {
    // 항목이 적을 때는 계열마다 막대를 나란히 배치해 세로 막대끼리 직접 비교합니다.
    const barWidth = Math.max(2, Math.min(34, (groupWidth * 0.72) / series.length));
    items.forEach((item, itemIndex) => {
      const groupCenter = margin.left + groupWidth * (itemIndex + 0.5);
      item.values.forEach((value, seriesIndex) => {
        const x = groupCenter + (seriesIndex - (series.length - 1) / 2) * barWidth;
        const barHeight = (value / maximum) * plotHeight;
        const bar = document.createElementNS(namespace, "rect");
        bar.setAttribute("x", x - barWidth * 0.42);
        bar.setAttribute("y", plotBottom - barHeight);
        bar.setAttribute("width", barWidth * 0.84);
        bar.setAttribute("height", Math.max(1, barHeight));
        bar.setAttribute("rx", 2);
        bar.setAttribute("fill", series[seriesIndex].color);
        bar.classList.add("chart-bar");
        const tooltip = document.createElementNS(namespace, "title");
        tooltip.textContent = `${item.label} · ${series[seriesIndex].label}: ${formatChartValue(value)}`;
        bar.append(tooltip);
        svg.append(bar);

        const valueLabel = document.createElementNS(namespace, "text");
        valueLabel.setAttribute("x", x);
        valueLabel.setAttribute("y", Math.max(margin.top - 5, plotBottom - barHeight - 7));
        valueLabel.setAttribute("text-anchor", "middle");
        valueLabel.classList.add("chart-value-label");
        valueLabel.textContent = formatChartValue(value);
        svg.append(valueLabel);
      });
    });
  }

  // 축 레이블은 공간이 좁을수록 세로에 가깝게 회전하며, 긴 날짜도 겹침을 줄입니다.
  items.forEach((item, index) => {
    const x = margin.left + groupWidth * (index + 0.5);
    const isDailyChart = container === dailyChart || container.id === "all-daily-chart";
    const label = document.createElementNS(namespace, "text");
    label.setAttribute("x", x);
    label.setAttribute("y", plotBottom + (dense ? 7 : 16));
    label.setAttribute("text-anchor", dense ? "end" : "end");
    label.setAttribute("transform", `rotate(${dense ? -90 : -48} ${x} ${plotBottom + (dense ? 7 : 16)})`);
    label.classList.add("chart-category-label");
    const dateParts = item.label.match(/^\d{4}-(\d{2}-\d{2})$/);
    label.textContent = isDailyChart && dense && dateParts
      ? dateParts[1]
      : item.label;
    label.setAttribute("aria-label", item.label);
    svg.append(label);
  });

  container.append(svg);
}

/**
 * 업로드 전이나 데이터가 없는 차트에서 공통으로 사용하는 안내 문구를 만듭니다.
 */
function createEmptyState(message) {
  const emptyState = document.createElement("p");
  emptyState.className = "empty-state";
  emptyState.textContent = message;
  return emptyState;
}

/**
 * CSV 열 전체를 지정된 표 영역에 그립니다. NG 행은 별도 CSS 클래스로 배경색을 구분합니다.
 * 셀 내용은 innerHTML이 아닌 textContent로 삽입해 CSV에 HTML 문자가 있어도 실행되지 않습니다.
 */
function renderTable(records, headers, target, includeSourceFile = false) {
  target.head.replaceChildren();
  target.body.replaceChildren();

  const headerRow = document.createElement("tr");
  const displayHeaders = includeSourceFile ? [...headers, "원본 파일"] : headers;
  displayHeaders.forEach((header) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = header;
    headerRow.append(cell);
  });
  target.head.append(headerRow);

  const fragment = document.createDocumentFragment();
  records.forEach((record) => {
    const row = document.createElement("tr");
    if (record.judgment === "NG") {
      row.classList.add("ng-row");
    }

    record.values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });
    if (includeSourceFile) {
      const sourceCell = document.createElement("td");
      sourceCell.textContent = record.sourceFile;
      row.append(sourceCell);
    }
    fragment.append(row);
  });

  target.body.append(fragment);
  target.count.textContent = `${formatInteger(records.length)}건`;
}

/**
 * 소수점은 사용자 요청에 따라 첫째 자리까지만 표시합니다.
 */
function formatOneDecimal(value) {
  return new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(value);
}

/**
 * 차트 값은 정수는 정수 그대로, 분 합계처럼 소수점이 의미 있는 값은 한 자리까지 표시합니다.
 */
function formatChartValue(value) {
  return Number.isInteger(value) ? formatInteger(value) : formatOneDecimal(value);
}

/**
 * 롤 수처럼 정수로 표시할 값에 천 단위 구분 기호를 적용합니다.
 */
function formatInteger(value) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0
  }).format(value);
}

/**
 * 메시지 색상과 접근성 상태를 함께 변경해 성공 안내와 오류를 구분합니다.
 */
function setMessage(message, isError) {
  messageElement.textContent = message;
  messageElement.classList.toggle("error", isError);
  messageElement.setAttribute("role", isError ? "alert" : "status");
}
