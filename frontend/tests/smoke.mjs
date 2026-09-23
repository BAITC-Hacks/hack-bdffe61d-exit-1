import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.TEST_URL || "http://127.0.0.1:5173";
const browser = await chromium.launch({
  executablePath: process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});
const errors = [];

function wavFile() {
  const samples = 60 * 8000;
  const bytes = Buffer.alloc(44 + samples, 128);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples, 40);
  return bytes;
}

try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel("Название совещания").fill("Проверка демо");
  await page.getByLabel("Дата и время").fill("2026-09-23T10:00");
  await page.getByLabel("Участник 1").fill("Тестовый участник");
  await page.locator('input[type="file"]').setInputFiles({ name: "demo.wav", mimeType: "audio/wav", buffer: wavFile() });
  await page.getByRole("button", { name: "Обработать совещание" }).click();
  await page.waitForURL("**/meetings/demo");
  assert.equal(await page.getByText("DEMO / MOCK MODE").count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Краткое содержание" }).count(), 1);
  assert.equal(await page.locator("tbody tr").count(), 3);
  assert.equal(await page.getByText("Требует уточнения").count() > 0, true);
  assert.equal(await page.getByText("Не указан").count() > 0, true);

  await page.getByRole("button", { name: "Изменить" }).first().click();
  await page.getByLabel("Текст поручения").fill("Проверенное поручение");
  await page.getByLabel("Ответственный").selectOption("p1");
  await page.getByLabel("Срок").fill("2026-10-01");
  await page.getByRole("button", { name: "Сохранить" }).click();
  assert.equal(await page.getByText("Проверенное поручение").count(), 1);
  if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, "meeting-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Посмотреть источник" }).first().click();
  assert.equal(await page.locator("#segment-s3").evaluate((el) => el.classList.contains("is-highlighted") && document.activeElement === el), true);
  await page.getByRole("button", { name: "Прослушать источник" }).first().click();
  await page.waitForFunction(() => document.querySelector("audio")?.currentTime >= 14);

  await page.getByRole("button", { name: "Подтвердить протокол" }).click();
  assert.equal(await page.getByText("Подтверждён", { exact: true }).count(), 1);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать DOCX" }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.docx$/);
  const data = await readFile(await download.path());
  assert.equal(data.subarray(0, 2).toString(), "PK");

  const mobile = await browser.newPage({ viewport: { width: 375, height: 812 } });
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(`${base}/meetings/demo`);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.TEST_SCREENSHOT_DIR) await mobile.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, "meeting-mobile.png"), fullPage: true });
  await mobile.keyboard.press("Tab");
  assert.equal(await mobile.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el !== document.body && getComputedStyle(el).outlineStyle !== "none";
  }), true);
  await mobile.getByRole("button", { name: "Посмотреть источник" }).first().focus();
  await mobile.keyboard.press("Enter");
  assert.equal(await mobile.locator("#segment-s3").evaluate((el) => el.classList.contains("is-highlighted")), true);
  await mobile.setViewportSize({ width: 320, height: 700 });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  const fixture = JSON.parse(await readFile(new URL("../src/mocks/meeting.json", import.meta.url), "utf8"));
  const real = await browser.newPage();
  real.on("pageerror", (error) => errors.push(error.message));
  let polls = 0;
  let itemPatches = 0;
  let speakerPatches = 0;
  let confirms = 0;
  let exports = 0;
  let audioRequests = 0;
  let confirmed = false;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PATCH, OPTIONS", "access-control-allow-headers": "content-type" };
  await real.route("http://localhost:8000/meetings/real-1/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (request.url().endsWith("/tasks/a1")) {
      assert.equal(request.method(), "PATCH");
      assert.deepEqual(JSON.parse(request.postData()), { text: "Реальное поручение", assignee_id: "p2", due_date: "2026-09-30" });
      itemPatches++;
      return route.fulfill({ status: 204, headers: cors });
    }
    if (request.url().endsWith("/speakers")) {
      assert.equal(request.method(), "PATCH");
      assert.deepEqual(JSON.parse(request.postData()), { mappings: [{ speaker: "Спикер 1", participant_id: "p2" }] });
      speakerPatches++;
      return route.fulfill({ status: 204, headers: cors });
    }
    if (request.url().endsWith("/confirm")) {
      assert.equal(request.method(), "POST");
      confirms++;
      confirmed = true;
      return route.fulfill({ status: 204, headers: cors });
    }
    if (request.url().endsWith("/audio")) {
      assert.equal(request.method(), "GET");
      audioRequests++;
      return route.fulfill({ body: wavFile(), headers: { ...cors, "content-type": "audio/wav" } });
    }
    if (request.url().endsWith("/export?format=docx")) {
      exports++;
      return route.fulfill({ body: Buffer.from("PK-demo"), headers: { ...cors, "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
    }
    throw new Error(`Unexpected API request: ${request.url()}`);
  });
  await real.route("http://localhost:8000/meetings/real-1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const status = ["queued", "queued", "running", "completed"][Math.min(polls++, 3)];
    await route.fulfill({ json: { ...fixture, id: "real-1", status, confirmed_at: confirmed ? new Date().toISOString() : null }, headers: cors });
  });
  await real.route("http://localhost:8000/meetings", (route) => route.fulfill({ json: { items: [{ id: "real-1", title: fixture.title, started_at: fixture.started_at, status: "completed", confirmed_at: null }] }, headers: cors }));
  await real.goto(`${base}/meetings/real-1`);
  await real.getByText("В очереди").waitFor();
  await real.getByText("Обрабатывается").waitFor({ timeout: 5000 });
  await real.getByText("Готово").waitFor({ timeout: 5000 });
  assert.equal(polls, 4);
  await real.waitForFunction(() => document.querySelector("audio")?.getAttribute("src")?.startsWith("blob:"));
  assert.equal(audioRequests >= 1, true);
  const backendAudioUrl = await real.locator("audio").getAttribute("src");
  assert.equal(await real.getByRole("button", { name: "Прослушать источник" }).first().isEnabled(), true);
  await real.getByRole("button", { name: "Прослушать источник" }).first().click();
  await real.waitForFunction(() => document.querySelector("audio")?.currentTime >= 14);
  const apiReads = await real.evaluate(async () => {
    const api = await import("/src/api/meetings.ts");
    const list = await api.listMeetings();
    return { count: list.items.length };
  });
  assert.deepEqual(apiReads, { count: 1 });
  await real.getByRole("button", { name: "Изменить" }).first().click();
  await real.getByLabel("Текст поручения").fill("Реальное поручение");
  await real.getByRole("button", { name: "Сохранить" }).click();
  await real.getByText("Реальное поручение").waitFor();
  await real.getByLabel("Спикер 1").selectOption("p2");
  await real.getByRole("button", { name: "Подтвердить протокол" }).click();
  await real.getByText("Подтверждён", { exact: true }).waitFor();
  const realDownload = real.waitForEvent("download");
  await real.getByRole("button", { name: "Скачать DOCX" }).click();
  await realDownload;
  assert.deepEqual([itemPatches, speakerPatches, confirms, exports], [1, 1, 1, 1]);
  await real.getByRole("link", { name: "Новое совещание" }).click();
  await real.waitForURL(`${base}/`);
  assert.equal(await real.evaluate(async (url) => fetch(url).then(() => true).catch(() => false), backendAudioUrl), false);

  const unavailable = await browser.newPage();
  unavailable.on("pageerror", (error) => errors.push(error.message));
  let failedAudioRequests = 0;
  await unavailable.route("http://localhost:8000/meetings/unavailable/audio", (route) => {
    failedAudioRequests++;
    return route.fulfill({ status: 503, headers: cors });
  });
  await unavailable.route("http://localhost:8000/meetings/unavailable", (route) => route.fulfill({ json: { ...fixture, id: "unavailable" }, headers: cors }));
  const failedAudioRequest = unavailable.waitForRequest("http://localhost:8000/meetings/unavailable/audio");
  await unavailable.goto(`${base}/meetings/unavailable`);
  await failedAudioRequest;
  await unavailable.getByRole("heading", { name: /Поручения/ }).waitFor();
  assert.equal(failedAudioRequests >= 1, true);
  assert.equal(await unavailable.getByRole("button", { name: "Подтвердить протокол" }).isEnabled(), true);
  assert.equal(await unavailable.locator("audio").count(), 0);

  const provided = await browser.newPage();
  let skippedAudioRequests = 0;
  await provided.route("http://localhost:8000/meetings/provided/audio", (route) => {
    skippedAudioRequests++;
    return route.fulfill({ body: wavFile(), headers: cors });
  });
  await provided.route("http://localhost:8000/meetings/provided", (route) => route.fulfill({ json: { ...fixture, id: "provided", audio_url: `data:audio/wav;base64,${wavFile().toString("base64")}` }, headers: cors }));
  await provided.goto(`${base}/meetings/provided`);
  await provided.locator("audio").waitFor();
  assert.equal((await provided.locator("audio").getAttribute("src")).startsWith("data:audio/wav"), true);
  assert.equal(skippedAudioRequests, 0);

  const failed = await browser.newPage();
  await failed.route("http://localhost:8000/meetings/failed", (route) => route.fulfill({ json: { ...fixture, status: "failed", error: "Ошибка распознавания" }, headers: { "access-control-allow-origin": "*" } }));
  await failed.goto(`${base}/meetings/failed`);
  await failed.getByText("Ошибка распознавания").waitFor();

  const empty = await browser.newPage();
  await empty.route("http://localhost:8000/meetings/empty", (route) => route.fulfill({ json: { ...fixture, action_items: [], segments: [], participants: [], speakers: [] }, headers: { "access-control-allow-origin": "*" } }));
  await empty.goto(`${base}/meetings/empty`);
  await empty.getByText("Поручения не обнаружены.").waitFor();
  const retry = await browser.newPage();
  let attempts = 0;
  await retry.route("http://localhost:8000/meetings/retry", (route) => {
    attempts++;
    return attempts <= 2
      ? route.fulfill({ status: 503, headers: cors })
      : route.fulfill({ json: { ...fixture, id: "retry" }, headers: cors });
  });
  await retry.goto(`${base}/meetings/retry`);
  await retry.getByText("Повторим запрос через 2 секунды.", { exact: false }).waitFor();
  await retry.getByText("Готово").waitFor({ timeout: 6000 });
  assert.equal(attempts, 3);
  if (process.env.REAL_TEST_URL) {
    const upload = await browser.newPage();
    upload.on("pageerror", (error) => errors.push(error.message));
    let creates = 0;
    let uploadedAudioRequests = 0;
    await upload.route("http://localhost:8000/meetings", async (route) => {
      assert.equal(route.request().method(), "POST");
      const payload = route.request().postData() || "";
      assert.equal(payload.includes("Проверка POST"), true);
      assert.equal(payload.includes("demo.wav"), true);
      assert.equal(payload.includes('name="participants_json"'), true);
      assert.equal(payload.includes('name="participants"'), false);
      creates++;
      await route.fulfill({ json: { id: "upload-1", status: "queued" }, headers: cors });
    });
    await upload.route("http://localhost:8000/meetings/upload-1", (route) => route.fulfill({ json: { ...fixture, id: "upload-1" }, headers: cors }));
    await upload.route("http://localhost:8000/meetings/upload-1/audio", (route) => {
      uploadedAudioRequests++;
      return route.fulfill({ body: wavFile(), headers: cors });
    });
    await upload.goto(process.env.REAL_TEST_URL);
    await upload.getByLabel("Название совещания").fill("Проверка POST");
    await upload.getByLabel("Дата и время").fill("2026-09-23T10:00");
    await upload.getByLabel("Участник 1").fill("Тестовый участник");
    await upload.locator('input[type="file"]').setInputFiles({ name: "demo.wav", mimeType: "audio/wav", buffer: wavFile() });
    await upload.getByRole("button", { name: "Обработать совещание" }).click();
    await upload.waitForURL("**/meetings/upload-1");
    await upload.getByRole("heading", { name: fixture.title }).waitFor();
    assert.equal(creates, 1);
    assert.equal((await upload.locator("audio").getAttribute("src")).startsWith("blob:"), true);
    assert.equal(uploadedAudioRequests, 0);
  }
  assert.deepEqual(errors, []);
  console.log("Smoke: demo and real API flow, backend audio playback/failure/cleanup, upload, edit, source, confirmation, DOCX, 375px, focus, queued/running/completed/failed/empty passed.");
} finally {
  await browser.close();
}
