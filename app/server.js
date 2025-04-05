const express = require('express');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const dotenv = require('dotenv');

dotenv.config();

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64) {
    console.error("❌ GOOGLE_APPLICATION_CREDENTIALS_BASE64 is not set.");
    process.exit(1);
}

const credentials = JSON.parse(Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
google.options({ auth });

const sheets = google.sheets('v4');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/scrape', async (req, res) => {
    try {
        const browser = await puppeteer.launch({ 
            headless: true,
            ignoreHTTPSErrors: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        const sheetId = process.env.GOOGLE_SHEET_ID;
        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!B:B',
        });

        const rows = data.values;
        let currentRowSheet2 = 2;
        let currentRowSheet3 = 2;

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const invoiceLink = rows[rowIndex][0];
            if (!invoiceLink || !/^https?:\/\//.test(invoiceLink)) continue;

            console.log(`🔄 Processing row ${rowIndex + 1} - ${invoiceLink}`);
            await page.goto(invoiceLink, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(resolve => setTimeout(resolve, 3000));

            const invoiceData = await page.evaluate(() => {
                const getText = (xpath) => {
                    const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    return element ? element.innerText.trim().replace('TVSH', 'VAT') : 'N/A';
                };

                const extractInvoiceNumber = () => getText('/html/body/app-root/app-verify-invoice/div/section[1]/div/div[1]/h4') || 'N/A';

                const extractItems = () => {
                    let items = [];
                    document.querySelector("button.show-more")?.click();
                    document.querySelectorAll("li.invoice-item").forEach(node => {
                        const itemName = node.querySelector(".invoice-item--title")?.innerText.trim() || "N/A";
                        if (itemName.includes("Numri i Artikujve")) return; 
                        items.push([
                            itemName,
                            node.querySelector(".invoice-item--quantity")?.innerText.trim() || "N/A",
                            node.querySelector(".invoice-item--unit-price")?.innerText.trim() || "N/A",
                            node.querySelector(".invoice-item--before-vat")?.innerText.trim() || "N/A",
                            node.querySelector(".invoice-item--price")?.innerText.trim() || "N/A",
                            node.querySelector(".invoice-item--vat")?.innerText.trim() || "N/A"
                        ]);
                    });
                    return items;
                };

                return {
                    businessName: getText('/html/body/app-root/app-verify-invoice/div/section[1]/div/ul/li[1]'),
                    invoiceNumber: extractInvoiceNumber(),
                    items: extractItems(),
                    grandTotal: getText('/html/body/app-root/app-verify-invoice/div/section[1]/div/div[2]/h1'),
                    vat: getText('/html/body/app-root/app-verify-invoice/div/section[1]/div/div[2]/small[2]/strong'),
                    invoiceType: getText('/html/body/app-root/app-verify-invoice/div/section[2]/div/div/div/div[5]/p')
                };
            });

            console.log(`✅ Extracted Data:`, invoiceData);
            if (invoiceData.businessName === 'N/A' && invoiceData.invoiceNumber === 'N/A') continue;

            if (invoiceData.items.length === 0) {
                console.log("⚠️ No items extracted. Adding placeholder row.");
                invoiceData.items.push(["N/A", "N/A", "N/A", "N/A", "N/A", "N/A"]);
            }

            let updateValuesSheet2 = invoiceData.items.map(item => [
                invoiceData.businessName, invoiceData.invoiceNumber, ...item
            ]);
            console.log("📌 Writing to Sheet2: ", updateValuesSheet2);

            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Sheet2!A${currentRowSheet2}`,
                valueInputOption: 'RAW',
                resource: { values: updateValuesSheet2 }
            });
            currentRowSheet2 += updateValuesSheet2.length;

            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Sheet3!A${currentRowSheet3}:E${currentRowSheet3}`,
                valueInputOption: 'RAW',
                resource: { values: [[
                    invoiceData.businessName,
                    invoiceData.invoiceNumber,
                    invoiceData.grandTotal,
                    invoiceData.vat,
                    invoiceData.invoiceType
                ]] }
            });
            currentRowSheet3++;
        }

        await browser.close();
        res.json({ success: true, message: "Scraping completed" });
    } catch (error) {
        console.error("❌ Error during scraping:", error);
        res.status(500).json({ success: false, message: "Scraping failed", error: error.toString() });
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));