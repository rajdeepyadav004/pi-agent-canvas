import { chromium } from 'playwright';
const link = 'ws://localhost:7466/r/3YPc6sVB_UffFVvL12qgyw.5Olqb2T3_JfClTZrjYXBpyTuUx1l9sOCnQgOwQVctyQ';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:3000/#' + link);
await page.waitForTimeout(12000); // let the mock host play its scripted session
await page.screenshot({ path: '/tmp/omp-collab.png' });
const text = await page.locator('body').innerText();
console.log('BODY >>>\n' + text.slice(0, 1200));
await browser.close();
