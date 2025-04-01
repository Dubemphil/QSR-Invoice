const puppeteer = require('puppeteer');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

async function scrapeInvoiceData(invoiceUrl, sheet2, sheet3) {
    console.log(`Starting scraping process for: ${invoiceUrl}`);

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    console.log("Navigating to invoice page...");
    await page.goto(invoiceUrl, { waitUntil: 'networkidle2' });

    console.log("Extracting invoice summary...");
    await page.waitForSelector('table');

    const invoiceData = await page.$$eval("table tr", rows => {
        return rows.slice(1, 2).map(row => {
            const cells = row.querySelectorAll("td");
            return {
                businessName: cells[0]?.innerText.trim() || '',
                invoiceNumber: cells[1]?.innerText.trim() || '',
                grandTotal: cells[2]?.innerText.trim() || '',
                vat: cells[3]?.innerText.trim() || '',
                invoiceType: cells[4]?.innerText.trim() || ''
            };
        })[0];
    });

    if (!invoiceData.businessName) {
        console.error("❌ Failed to extract invoice details. Skipping...");
        await browser.close();
        return;
    }

    await sheet2.addRow(Object.values(invoiceData));
    console.log("✅ Invoice data extracted and added to Sheet2:", invoiceData);

    console.log("Checking for 'Read More' button...");
    const readMoreButton = await page.$('.read-more');

    if (readMoreButton) {
        console.log("Clicking 'Read More' button...");
        await readMoreButton.click();
        await page.waitForTimeout(3000);
    } else {
        console.log("⚠️ 'Read More' button not found, continuing with available data.");
    }

    console.log("Extracting invoice items...");
    const invoiceItems = await page.$$eval('li.invoice-item', items => {
        return items.map(item => {
            const getText = (el, selector) => el.querySelector(selector)?.innerText.trim() || '';
            return {
                itemName: getText(item, '.invoice-item-title'),
                unitPrice: getText(item, '.invoice-item-unit-price'),
                quantity: getText(item, '.invoice-item-quantity'),
                totalPrice: getText(item, '.invoice-item-price'),
                beforeVAT: getText(item, '.invoice-item-before-vat'),
                vat: getText(item, '.invoice-item-vat')
            };
        });
    });

    if (invoiceItems.length > 0) {
        const rows = invoiceItems.map(item => [
            invoiceData.businessName,
            invoiceData.invoiceNumber,
            item.itemName,
            item.unitPrice,
            item.quantity,
            item.totalPrice,
            item.beforeVAT,
            item.vat
        ]);

        await sheet3.addRows(rows);
        console.log(`✅ ${invoiceItems.length} invoice items extracted and added to Sheet3.`);
    } else {
        console.log("⚠️ No invoice items found.");
    }

    await browser.close();
    console.log("✅ Scraping completed for:", invoiceUrl);
}

async function main() {
    console.log("Initializing Google Sheets connection...");
    const doc = new GoogleSpreadsheet('YOUR_GOOGLE_SHEET_ID');
    await doc.useServiceAccountAuth(require('./credentials.json'));
    await doc.loadInfo();

    const sheet1 = doc.sheetsByIndex[0];
    const sheet2 = doc.sheetsByIndex[1];
    const sheet3 = doc.sheetsByIndex[2];

    console.log("Fetching invoice links from Sheet1...");
    const rows = await sheet1.getRows();
    const invoiceLinks = rows.map(row => row._rawData[0]).filter(link => link);

    if (invoiceLinks.length === 0) {
        console.log("⚠️ No invoice links found in Sheet1. Exiting...");
        return;
    }

    for (const link of invoiceLinks) {
        await scrapeInvoiceData(link, sheet2, sheet3);
    }
}

app.get('/start-scraping', async (req, res) => {
    console.log("Received request to start scraping...");
    await main();
    res.send("Scraping process started. Check logs for progress.");
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

main().catch(console.error);
