// 无运行时依赖的 OOXML 快照导出。生成标准 .xlsx ZIP，并包含可编辑图表。
export interface SheetData {
  name: string;
  rows: Cell[][];
  chart?: boolean;
  raw?: boolean;
}
export type Cell =
  string | number | null | { formula: string; value: string | number };
const xml = (v: unknown) =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const utf8 = (text: string): Uint8Array => {
  const bytes: number[] = [];
  for (const ch of text) {
    const p = ch.codePointAt(0)!;
    if (p < 128) bytes.push(p);
    else if (p < 2048) bytes.push(192 | (p >> 6), 128 | (p & 63));
    else if (p < 65536)
      bytes.push(224 | (p >> 12), 128 | ((p >> 6) & 63), 128 | (p & 63));
    else
      bytes.push(
        240 | (p >> 18),
        128 | ((p >> 12) & 63),
        128 | ((p >> 6) & 63),
        128 | (p & 63),
      );
  }
  return new Uint8Array(bytes);
};
const crc = (bytes: Uint8Array): number => {
  let n = 0xffffffff;
  for (const b of bytes) {
    n ^= b;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
};
export function zipText(files: { name: string; text: string }[]): ArrayBuffer {
  const parts: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8(file.name),
      data = utf8(file.text),
      sum = crc(data),
      head = new Uint8Array(30 + name.length),
      dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x800, true);
    dv.setUint16(12, 33, true);
    dv.setUint32(14, sum, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    head.set(name, 30);
    parts.push(head, data);
    const entry = new Uint8Array(46 + name.length),
      ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(8, 0x800, true);
    ev.setUint16(14, 33, true);
    ev.setUint32(16, sum, true);
    ev.setUint32(20, data.length, true);
    ev.setUint32(24, data.length, true);
    ev.setUint16(28, name.length, true);
    ev.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);
    offset += head.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0),
    end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  parts.push(...central, end);
  const result = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const p of parts) {
    result.set(p, at);
    at += p.length;
  }
  return result.buffer;
}
function col(index: number): string {
  let text = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    text = String.fromCharCode(65 + ((n - 1) % 26)) + text;
  return text;
}
const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relation =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pkgRel = "http://schemas.openxmlformats.org/package/2006/relationships";
export function createXlsx(sheets: SheetData[]): ArrayBuffer {
  const files: { name: string; text: string }[] = [];
  const overrides: string[] = [];
  const add = (name: string, text: string, type?: string): void => {
    files.push({
      name,
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text,
    });
    if (type)
      overrides.push(
        '<Override PartName="/' + name + '" ContentType="' + type + '"/>',
      );
  };
  const spreadsheetType =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.";
  add(
    "_rels/.rels",
    '<Relationships xmlns="' +
      pkgRel +
      '"><Relationship Id="rId1" Type="' +
      relation +
      '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  add(
    "xl/workbook.xml",
    '<workbook xmlns="' +
      main +
      '" xmlns:r="' +
      relation +
      '"><sheets>' +
      sheets
        .map(
          (s, i) =>
            '<sheet name="' +
            xml(s.name) +
            '" sheetId="' +
            (i + 1) +
            '" r:id="rId' +
            (i + 1) +
            '"/>',
        )
        .join("") +
      '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    spreadsheetType + "sheet.main+xml",
  );
  add(
    "xl/_rels/workbook.xml.rels",
    '<Relationships xmlns="' +
      pkgRel +
      '">' +
      sheets
        .map(
          (_, i) =>
            '<Relationship Id="rId' +
            (i + 1) +
            '" Type="' +
            relation +
            '/worksheet" Target="worksheets/sheet' +
            (i + 1) +
            '.xml"/>',
        )
        .join("") +
      '<Relationship Id="styles" Type="' +
      relation +
      '/styles" Target="styles.xml"/></Relationships>',
  );
  add(
    "xl/styles.xml",
    '<styleSheet xmlns="' +
      main +
      '"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FF263650"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font><font><b/><sz val="16"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2468E8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    spreadsheetType + "styles+xml",
  );
  sheets.forEach((s, i) => {
    const id = i + 1,
      chart = !!s.chart && s.rows.length > 3,
      last = col(Math.max(...s.rows.map((r) => r.length)) - 1);
    const rows = s.rows
      .map(
        (row, ri) =>
          '<row r="' +
          (ri + 1) +
          '" ht="' +
          (ri === 0 ? 34 : ri < 3 ? 30 : 36) +
          '" customHeight="1">' +
          row
            .map((c, ci) => {
              const address = col(ci) + (ri + 1),
                rate = s.raw
                  ? [7, 9, 11, 13, 15, 17, 19, 22].includes(ci)
                  : ci === 1 && !s.name.includes("迟到人数");
              const style =
                ri === 0 ? 2 : ri === 2 ? 1 : rate && ri > 2 ? 3 : 0;
              if (c === null) return "";
              if (typeof c === "object")
                return (
                  '<c r="' +
                  address +
                  '" s="' +
                  style +
                  '"' +
                  (typeof c.value === "string" ? ' t="str"' : "") +
                  "><f>" +
                  xml(c.formula) +
                  "</f><v>" +
                  xml(c.value) +
                  "</v></c>"
                );
              return typeof c === "number"
                ? '<c r="' +
                    address +
                    '" s="' +
                    style +
                    '"><v>' +
                    c +
                    "</v></c>"
                : '<c r="' +
                    address +
                    '" s="' +
                    style +
                    '" t="inlineStr"><is><t xml:space="preserve">' +
                    xml(c) +
                    "</t></is></c>";
            })
            .join("") +
          "</row>",
      )
      .join("");
    add(
      "xl/worksheets/sheet" + id + ".xml",
      '<worksheet xmlns="' +
        main +
        '" xmlns:r="' +
        relation +
        '"><dimension ref="A1:' +
        last +
        s.rows.length +
        '"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols><col min="1" max="1" width="' +
        (s.raw ? 9 : 30) +
        '" customWidth="1"/><col min="2" max="2" width="24" customWidth="1"/><col min="3" max="4" width="22" customWidth="1"/><col min="5" max="23" width="12" customWidth="1"/><col min="24" max="27" width="34" customWidth="1"/></cols><sheetData>' +
        rows +
        '</sheetData><autoFilter ref="A3:' +
        last +
        s.rows.length +
        '"/><mergeCells count="2"><mergeCell ref="A1:' +
        (s.raw ? "AA" : "F") +
        '1"/><mergeCell ref="A2:' +
        (s.raw ? "AA" : "F") +
        '2"/></mergeCells>' +
        (chart ? '<drawing r:id="drawing"/>' : "") +
        "</worksheet>",
      spreadsheetType + "worksheet+xml",
    );
    if (chart) {
      add(
        "xl/worksheets/_rels/sheet" + id + ".xml.rels",
        '<Relationships xmlns="' +
          pkgRel +
          '"><Relationship Id="drawing" Type="' +
          relation +
          '/drawing" Target="../drawings/drawing' +
          id +
          '.xml"/></Relationships>',
      );
      add(
        "xl/drawings/drawing" + id + ".xml",
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="' +
          xml(s.name) +
          '"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="' +
          relation +
          '" r:id="chart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>',
        "application/vnd.openxmlformats-officedocument.drawing+xml",
      );
      add(
        "xl/drawings/_rels/drawing" + id + ".xml.rels",
        '<Relationships xmlns="' +
          pkgRel +
          '"><Relationship Id="chart" Type="' +
          relation +
          '/chart" Target="../charts/chart' +
          id +
          '.xml"/></Relationships>',
      );
      const sheetName = "'" + s.name.replace(/'/g, "''") + "'",
        data = s.rows.slice(3),
        fmt = s.name.includes("人数") ? "0" : "0.0%";
      add(
        "xl/charts/chart" + id + ".xml",
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>' +
          xml(s.name) +
          '</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>' +
          xml(s.name) +
          "</c:v></c:tx><c:cat><c:strRef><c:f>" +
          xml(sheetName + "!$A$4:$A$" + s.rows.length) +
          '</c:f><c:strCache><c:ptCount val="' +
          data.length +
          '"/>' +
          data
            .map(
              (r, j) =>
                '<c:pt idx="' + j + '"><c:v>' + xml(r[0]) + "</c:v></c:pt>",
            )
            .join("") +
          "</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>" +
          xml(sheetName + "!$B$4:$B$" + s.rows.length) +
          "</c:f><c:numCache><c:formatCode>" +
          fmt +
          '</c:formatCode><c:ptCount val="' +
          data.length +
          '"/>' +
          data
            .map(
              (r, j) => '<c:pt idx="' + j + '"><c:v>' + r[1] + "</c:v></c:pt>",
            )
            .join("") +
          '</c:numCache></c:numRef></c:val></c:ser><c:axId val="10"/><c:axId val="20"/></c:barChart><c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="20"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:numFmt formatCode="' +
          fmt +
          '" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="10"/><c:crosses val="autoZero"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>',
        "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
      );
    }
  });
  files.push({
    name: "[Content_Types].xml",
    text:
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      overrides.join("") +
      "</Types>",
  });
  return zipText(files);
}
