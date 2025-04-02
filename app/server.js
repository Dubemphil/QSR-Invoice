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
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        const sheetId = process.env.GOOGLE_SHEET_ID;
        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!B:B',
        });

        const rows = data.values;
        let extractedData = [];
        let currentRowSheet2 = 2;
        let currentRowSheet3 = 2;

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const invoiceLink = rows[rowIndex][0];
            if (!invoiceLink || !/^https?:\/\//.test(invoiceLink)) continue;

            await page.goto(invoiceLink, { waitUntil: 'networkidle2' });
            await new Promise(resolve => setTimeout(resolve, 3000));

            const invoiceData = await page.evaluate(() => {
                const getText = (selector) => {
                    const element = document.querySelector(selector);
                    return element ? element.innerText.trim().replace('TVSH', 'VAT') : 'N/A';
                };

                const extractItems = () => {
                    let items = [];
                    const container = document.querySelector("ul.invoice-items-list");
                    if (!container) return [['N/A', 'N/A', 'N/A', 'N/A', 'N/A']];
                    
                    container.querySelectorAll("li.invoice-item").forEach(item => {
                        const title = item.querySelector(".invoice-item--title")?.innerText.trim() || 'N/A';
                        const unitPrice = item.querySelector(".invoice-item--unit-price")?.innerText.trim() || 'N/A';
                        const price = item.querySelector(".invoice-item--price")?.innerText.trim() || 'N/A';
                        const quantity = item.querySelector(".invoice-item--quantity")?.innerText.trim() || 'N/A';
                        const vat = item.querySelector(".invoice-item--vat")?.innerText.trim() || 'N/A';
                        items.push([title, quantity, unitPrice, price, vat]);
                    });
                    return items;
                };

                return {
                    businessName: getText(".invoice-business-name"),
                    invoiceNumber: getText(".invoice-number"),
                    items: extractItems(),
                    grandTotal: getText(".invoice-total"),
                    vat: getText(".invoice-vat"),
                    invoiceType: getText(".invoice-type")
                };
            });

            if (invoiceData.businessName === 'N/A' && invoiceData.invoiceNumber === 'N/A') continue;
            
            let updateValuesSheet2 = invoiceData.items.map(item => [
                invoiceData.businessName,
                invoiceData.invoiceNumber,
                ...item
            ]);
            
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Sheet2!A${currentRowSheet2}`,
                valueInputOption: 'RAW',
                resource: { values: updateValuesSheet2 }
            });
            currentRowSheet2 += updateValuesSheet2.length;
            
            const updateValuesSheet3 = [[
                invoiceData.businessName,
                invoiceData.invoiceNumber,
                invoiceData.grandTotal,
                invoiceData.vat,
                invoiceData.invoiceType
            ]];
            
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Sheet3!A${currentRowSheet3}:E${currentRowSheet3}`,
                valueInputOption: 'RAW',
                resource: { values: updateValuesSheet3 }
            });
            currentRowSheet3++;

            extractedData.push(invoiceData);
        }

        await browser.close();
        res.json({ success: true, message: "Scraping completed", data: extractedData });
    } catch (error) {
        console.error("❌ Error during scraping:", error);
        res.status(500).json({ success: false, message: "Scraping failed", error: error.toString() });
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));
