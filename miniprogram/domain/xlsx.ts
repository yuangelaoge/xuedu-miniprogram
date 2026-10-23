// 无运行时依赖的 OOXML 快照导出。生成标准 .xlsx ZIP，并包含可编辑图表。
export interface SheetData {
  name: string;
  rows: Cell[][];
  chart?: boolean;
  raw?: boolean;
  groupHeaders?: boolean;
  chartPercent?: boolean;
  chartSeries?: {name:string;column:number;color:string;labels?:boolean}[];
  percentColumns?: number[];
  /** Zero-based columns retained for formulas but hidden in the exported workbook. */
  hiddenColumns?: number[];
  /** Explicit OOXML ranges, including title ranges, for grouped schedule rows. */
  merges?: string[];
  columnWidths?: number[];
  autoFilter?: boolean;
}
export type Cell =
  string | number | null | { formula: string; value: string | number; error?:boolean };
const cached = (cell: Cell): string | number | null => typeof cell === "object" && cell !== null ? cell.value : cell;
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
const noFill='<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>';
const chartSeries=(s:SheetData)=>s.chartSeries || [{name:s.name,column:1,color:'2E75B6',labels:true}];
const valueName=(id:number,series:number)=>`ChartValues${id}_${series}`;
function chartXml(s:SheetData,id:number):string {
  const data=s.rows.slice(3).filter(r=>typeof cached(r[1])==='number');
  const fmt=s.chartPercent===false || s.name.includes('人数')?'0':'0.00%';
  const quote="'"+s.name.replace(/'/g,"''")+"'!";
  const textStyle=(rotation=0,size=1100)=>`<c:txPr><a:bodyPr rot="${rotation}"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}"><a:solidFill><a:srgbClr val="404040"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>`;
  const series=chartSeries(s).map((spec,i)=>`<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${xml(spec.name)}</c:v></c:tx><c:spPr>${spec.color?`<a:solidFill><a:srgbClr val="${spec.color}"/></a:solidFill>`:'<a:noFill/>'}<a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>${spec.labels?`<c:dLbls><c:numFmt formatCode="${fmt}" sourceLinked="0"/>${textStyle(0,1100)}<c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/></c:dLbls>`:'<c:dLbls><c:delete val="1"/></c:dLbls>'}<c:cat><c:strRef><c:f>${xml(quote+'ChartLabels'+id)}</c:f><c:strCache><c:ptCount val="${data.length}"/>${data.map((r,j)=>`<c:pt idx="${j}"><c:v>${xml(cached(r[0]))}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${xml(quote+valueName(id,i))}</c:f><c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${data.length}"/>${data.map((r,j)=>typeof cached(r[spec.column])==='number'?`<c:pt idx="${j}"><c:v>${cached(r[spec.column])}</c:v></c:pt>`:'').join('')}</c:numCache></c:numRef></c:val></c:ser>`).join('');
  return `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:lang val="zh-CN"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1600" b="1"/><a:t>${xml(s.name)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="90"/><c:overlap val="100"/><c:axId val="10"/><c:axId val="20"/></c:barChart><c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${textStyle(-2700000,1100)}<c:crossAx val="20"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:tickLblSkip val="1"/></c:catAx><c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${fmt}" sourceLinked="0"/><c:majorTickMark val="none"/><c:tickLblPos val="nextTo"/>${textStyle()}<c:crossAx val="10"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>${noFill}</c:plotArea><c:plotVisOnly val="0"/><c:dispBlanksAs val="gap"/></c:chart>${noFill}</c:chartSpace>`;
}
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
      '</sheets><definedNames>' + sheets.map((s,i)=>{
        if(!s.chart || s.rows.length<=3)return '';
        const sheet="'"+s.name.replace(/'/g,"''")+"'!";
        const range=(column:string)=>xml(`OFFSET(${sheet}$${column}$4,0,0,MAX(1,COUNT(${sheet}$B$4:$B$${s.rows.length})),1)`);
        return `<definedName localSheetId="${i}" name="ChartLabels${i+1}">${range('A')}</definedName>`+chartSeries(s).map((series,j)=>`<definedName localSheetId="${i}" name="${valueName(i+1,j)}">${range(col(series.column))}</definedName>`).join('');
      }).join('') + '</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
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
      '"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FF263650"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font><font><b/><sz val="16"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2468E8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    spreadsheetType + "styles+xml",
  );
  sheets.forEach((s, i) => {
    const id = i + 1,
      chart = !!s.chart && s.rows.length > 3,
      last = col(Math.max(...s.rows.map((r) => r.length)) - 1);
    const columns = Array.from({ length: Math.max(27, ...s.rows.map(r => r.length)) }, (_, ci) => {
      const width = s.columnWidths?.[ci] ?? (ci === 0 ? (s.raw ? 9 : 30) : ci === 1 ? 24 : ci < 4 ? 22 : ci < 23 ? 12 : 34);
      return `<col min="${ci + 1}" max="${ci + 1}" width="${width}" customWidth="1"${s.hiddenColumns?.includes(ci) ? ' hidden="1"' : ''}/>`;
    }).join("");
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
                rate = s.percentColumns ? s.percentColumns.includes(ci) : s.raw
                  ? [7, 9, 11, 13, 15, 17, 19, 22].includes(ci)
                  : ci === 1 && (s.chartPercent ?? !s.name.includes("迟到人数"));
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
                  (c.error ? ' t="e"' : typeof c.value === "string" ? ' t="str"' : "") +
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
        '"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols>' +
        columns +
        '</cols><sheetData>' +
        rows +
        '</sheetData>' +
        (s.autoFilter === false ? '' : '<autoFilter ref="A3:'+last+s.rows.length+'"/>') +
        (s.merges ? '<mergeCells count="'+s.merges.length+'">'+s.merges.map(ref=>'<mergeCell ref="'+xml(ref)+'"/>').join('')+'</mergeCells>' :
          '<mergeCells count="'+(s.groupHeaders?5:2)+'"><mergeCell ref="A1:'+(s.raw ? 'AA' : 'F')+'1"/>' +
          (s.groupHeaders ? '<mergeCell ref="A2:D2"/><mergeCell ref="E2:L2"/><mergeCell ref="M2:T2"/><mergeCell ref="U2:Z2"/>' : '<mergeCell ref="A2:'+(s.raw ? 'AA' : 'F')+'2"/>')+'</mergeCells>') +
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
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="' + (Math.max(1000,s.rows.slice(3).filter(r=>typeof cached(r[1])==="number").length*76)*9525) + '" cy="5715000"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="' +
          xml(s.name) +
          '"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="' +
          relation +
          '" r:id="chart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>',
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
      add(
        "xl/charts/chart" + id + ".xml",
        chartXml(s,id),
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
