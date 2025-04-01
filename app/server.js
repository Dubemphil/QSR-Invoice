const puppeteer = require('puppeteer');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const express = require('express');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Function to scrape invoice data
async function scrapeInvoiceData(invoiceUrl, sheet2, sheet3) {
    console.log(`Starting scraping process for: ${invoiceUrl}`);
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    
    console.log("Navigating to invoice page...");
    await page.goto(invoiceUrl, { waitUntil: 'networkidle2' });

    // Extract invoice data (Sheet2)
    console.log("Extracting invoice data...");
    const invoiceData = await page.evaluate(() => {
        const getText = (selector) => {
            const element = document.querySelector(selector);
            return element ? element.innerText.trim() : '';
        };

        return {
            businessName: getText('table tr:nth-child(2) td:nth-child(1)'),
            invoiceNumber: getText('table tr:nth-child(2) td:nth-child(2)'),
            grandTotal: getText('table tr:nth-child(2) td:nth-child(3)'),
            vat: getText('table tr:nth-child(2) td:nth-child(4)'),
            invoiceType: getText('table tr:nth-child(2) td:nth-child(5)')
        };
    });

    await sheet2.addRow([invoiceData.businessName, invoiceData.invoiceNumber, invoiceData.grandTotal, invoiceData.vat, invoiceData.invoiceType]);
    console.log("Invoice data extracted and added to Sheet2:", invoiceData);

    // Handle 'Read more' if present
    console.log("Checking for 'Read More' button...");
    const readMoreButton = await page.$('.read-more');
    if (readMoreButton) {
        console.log("Clicking 'Read More' button...");
        await readMoreButton.click();
        await page.waitForTimeout(2000); // Wait for new content to load
    }

    // Extract invoice items (Sheet3)
    console.log("Extracting invoice items...");
    const invoiceItems = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('li.invoice-item')).map(item => {
            const getText = (el, selector) => {
                const element = el.querySelector(selector);
                return element ? element.innerText.trim() : '';
            };
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

    for (const item of invoiceItems) {
        await sheet3.addRow([
            invoiceData.businessName,
            invoiceData.invoiceNumber,
            item.itemName,
            item.unitPrice,
            item.quantity,
            item.totalPrice,
            item.beforeVAT,
            item.vat
        ]);
    }
    console.log("Invoice items extracted and added to Sheet3:", invoiceItems);
    
    await browser.close();
    console.log("Scraping process completed for:", invoiceUrl);
}

// Main function to execute scraping
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
    const invoiceLinks = rows.map(row => row._rawData[0]);

    for (const link of invoiceLinks) {
        if (link) await scrapeInvoiceData(link, sheet2, sheet3);
    }
}

// Express route to trigger scraping
app.get('/start-scraping', async (req, res) => {
    console.log("Received request to start scraping...");
    await main();
    res.send("Scraping process started. Check logs for progress.");
});

// Start Express server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Execute main function on startup
main().catch(console.error);
