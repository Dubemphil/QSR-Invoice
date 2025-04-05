const express = require('express');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SHEET_ID = 'your-google-sheet-id'; // Replace with your actual Sheet ID

async function updateStatus(sheets, sheetId, rowIndex, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!B${rowIndex}`,
    valueInputOption: 'RAW',
    resource: {
      values: [[status]],
    },
  });
}

app.post('/scrape', async (req, res) => {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    // Fetch URLs and statuses from Sheet1
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:B',
    });

    let rows = data.values || [];

    if (rows.length === 0) {
      return res.json({ success: false, message: "Sheet1 is empty." });
    }

    const urls = [];
    const rowMap = {};

    rows.forEach((row, index) => {
      const url = row[0]?.trim();
      const status = row[1]?.trim();
      if (url && /^https?:\/\//.test(url) && status !== '✅ Done') {
        if (!rowMap[url]) {
          rowMap[url] = index + 1; // Google Sheets rows are 1-indexed
          urls.push(url);
        }
      }
    });

    if (urls.length === 0) {
      return res.json({ success: false, message: "No new URLs to process." });
    }

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    const sheet2Data = [['Business Name', 'Invoice Number', 'Grand Total', 'VAT', 'Invoice Type']];
    const sheet3Data = [['Invoice ID', 'Item Name', 'Quantity', 'Unit Price', 'Total Price', 'Discount']];

    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const invoiceData = await page.evaluate(() => {
          const getText = (selector) => document.querySelector(selector)?.innerText.trim() || '';
          return {
            businessName: getText('.business-name'),
            invoiceNumber: getText('.invoice-number'),
            grandTotal: getText('.grand-total'),
            vat: getText('.vat'),
            invoiceType: getText('.invoice-type'),
            items: Array.from(document.querySelectorAll('.item-row')).map(item => ({
              itemName: item.querySelector('.item-name')?.innerText.trim() || '',
              quantity: item.querySelector('.item-quantity')?.innerText.trim() || '',
              unitPrice: item.querySelector('.item-unit-price')?.innerText.trim() || '',
              totalPrice: item.querySelector('.item-total-price')?.innerText.trim() || '',
              discount: item.querySelector('.item-discount')?.innerText.trim() || '',
            })),
          };
        });

        if (!invoiceData.invoiceNumber) {
          console.log(`⚠️ No invoice data found at: ${url}`);
          continue;
        }

        const invoiceId = invoiceData.invoiceNumber;
        sheet2Data.push([
          invoiceData.businessName,
          invoiceData.invoiceNumber,
          invoiceData.grandTotal,
          invoiceData.vat,
          invoiceData.invoiceType,
        ]);

        invoiceData.items.forEach(item => {
          sheet3Data.push([
            invoiceId,
            item.itemName,
            item.quantity,
            item.unitPrice,
            item.totalPrice,
            item.discount,
          ]);
        });

        // ✅ Mark as processed
        await updateStatus(sheets, SHEET_ID, rowMap[url], '✅ Done');

      } catch (err) {
        console.error(`Error processing ${url}:`, err);
        // Optional: you can mark as "Failed" if you want
        await updateStatus(sheets, SHEET_ID, rowMap[url], '❌ Failed');
      }
    }

    await browser.close();

    // Write to Sheet2
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Sheet2!A1',
      valueInputOption: 'RAW',
      resource: { values: sheet2Data },
    });

    // Write to Sheet3
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Sheet3!A1',
      valueInputOption: 'RAW',
      resource: { values: sheet3Data },
    });

    res.json({ success: true, message: 'Scraping completed successfully.' });

  } catch (error) {
    console.error('Error in /scrape route:', error);
    res.status(500).json({ success: false, message: 'Error occurred.', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
