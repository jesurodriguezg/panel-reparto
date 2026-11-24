'use strict';

const zlib = require('node:zlib');

// Tabla CRC-32 estándar (polinomio IEEE 802.3 0xEDB88320)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Empaqueta archivos en un contenedor ZIP estándar con compresión DEFLATE y soporte UTF-8.
 */
function buildZipBuffer(files) {
  const { dosTime, dosDate } = getDosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(String(file.name), 'utf8');
    const rawBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const compressedBuf = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // Bit 11: UTF-8 filename encoding
    localHeader.writeUInt16LE(8, 8); // Compression method 8 = DEFLATE
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length

    localParts.push(localHeader, nameBuf, compressedBuf);

    // Central directory file header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0x0800, 8); // Bit 11: UTF-8
    centralHeader.writeUInt16LE(8, 10); // DEFLATE
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // File comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE(0, 38); // External file attributes
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressedBuf.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // ZIP file comment length

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

/**
 * Elimina caracteres de control inválidos en XML 1.0 y escapa entidades XML.
 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colIndexToLetter(index) {
  let n = Number(index);
  let out = '';
  while (n >= 0) {
    out = String.fromCharCode((n % 26) + 65) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

function sanitizeSheetName(name) {
  const cleaned = String(name || 'Contactos Whaticket')
    .replace(/[\[\]:*?\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || 'Contactos';
}

function inlineStrCell(ref, styleIdx, rawValue) {
  const text = String(rawValue ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const needsPreserve = /^\s|\s$|\n/.test(text);
  const spaceAttr = needsPreserve ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr" s="${styleIdx}"><is><t${spaceAttr}>${escapeXml(text)}</t></is></c>`;
}

function buildContentTypesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '</Types>'
  ].join('');
}

function buildRootRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '</Relationships>'
  ].join('');
}

function buildWorkbookXml(sheetName) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheets>',
    `<sheet name="${escapeXml(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/>`,
    '</sheets>',
    '</workbook>'
  ].join('');
}

function buildWorkbookRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '</Relationships>'
  ].join('');
}

/**
 * Genera xl/styles.xml siguiendo el orden estricto de ECMA-376:
 * - s="0": Normal
 * - s="1": Encabezado (negrita blanca sobre #3B5BDB)
 * - s="2": Texto explícito (numFmtId="49" = formato "@" de Excel para teléfonos)
 */
function buildStylesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="2">',
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>',
    '</fonts>',
    '<fills count="3">',
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FF3B5BDB"/><bgColor indexed="64"/></patternFill></fill>',
    '</fills>',
    '<borders count="2">',
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>',
    '</borders>',
    '<cellStyleXfs count="1">',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>',
    '</cellStyleXfs>',
    '<cellXfs count="3">',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>',
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
    '</cellXfs>',
    '<cellStyles count="1">',
    '<cellStyle name="Normal" xfId="0" builtinId="0"/>',
    '</cellStyles>',
    '</styleSheet>'
  ].join('');
}

function buildWorksheetXml({ columns, rows }) {
  const safeCols = Array.isArray(columns) ? columns : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const colCount = Math.max(1, safeCols.length);
  const lastColLetter = colIndexToLetter(colCount - 1);
  const totalRows = 1 + safeRows.length;
  const dimensionRef = `A1:${lastColLetter}${totalRows}`;

  const colsXml = safeCols
    .map((c, idx) => {
      const width = Math.max(8, Number(c.width) || 18);
      const colNum = idx + 1;
      return `<col min="${colNum}" max="${colNum}" width="${width}" customWidth="1"/>`;
    })
    .join('');

  const headerCells = safeCols
    .map((c, idx) => inlineStrCell(`${colIndexToLetter(idx)}1`, 1, c.header || c.key || ''))
    .join('');
  const rowXmlParts = [`<row r="1" ht="22" customHeight="1">${headerCells}</row>`];

  for (let rIdx = 0; rIdx < safeRows.length; rIdx++) {
    const rowNum = rIdx + 2;
    const rowData = safeRows[rIdx] || {};
    const cellsXml = safeCols
      .map((col, cIdx) => {
        const ref = `${colIndexToLetter(cIdx)}${rowNum}`;
        const val = rowData[col.key];
        if (col.type === 'number') {
          const num = Number(val);
          if (Number.isFinite(num)) {
            return `<c r="${ref}" t="n" s="0"><v>${num}</v></c>`;
          }
          return inlineStrCell(ref, 0, '');
        }
        // type === 'text' usa estilo 2 (numFmtId=49 "@") para preservar texto exacto en Excel
        const styleIdx = col.type === 'text' ? 2 : 0;
        return inlineStrCell(ref, styleIdx, val);
      })
      .join('');
    rowXmlParts.push(`<row r="${rowNum}">${cellsXml}</row>`);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="${dimensionRef}"/>`,
    '<sheetViews>',
    '<sheetView tabSelected="1" workbookViewId="0">',
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    '</sheetView>',
    '</sheetViews>',
    '<sheetFormatPr defaultRowHeight="18"/>',
    colsXml ? `<cols>${colsXml}</cols>` : '',
    `<sheetData>${rowXmlParts.join('')}</sheetData>`,
    '</worksheet>'
  ].join('');
}

/**
 * Construye un archivo .xlsx válido en memoria (Buffer) sin dependencias externas.
 */
function buildXlsxBuffer({ sheetName = 'Contactos Whaticket', columns = [], rows = [] } = {}) {
  const files = [
    { name: '[Content_Types].xml', data: buildContentTypesXml() },
    { name: '_rels/.rels', data: buildRootRelsXml() },
    { name: 'xl/workbook.xml', data: buildWorkbookXml(sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', data: buildWorkbookRelsXml() },
    { name: 'xl/styles.xml', data: buildStylesXml() },
    { name: 'xl/worksheets/sheet1.xml', data: buildWorksheetXml({ columns, rows }) }
  ];
  return buildZipBuffer(files);
}

module.exports = {
  buildXlsxBuffer,
  buildZipBuffer,
  escapeXml,
  colIndexToLetter,
  crc32
};
