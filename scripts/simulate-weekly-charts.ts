import fs from 'node:fs';
import path from 'node:path';
import { exportXlsx } from '../miniprogram/domain/reports';
import { weeklyChartFixture } from '../tests/helpers/weekly-charts';

const output=path.resolve(process.argv[2] || 'artifacts/offline-weekly-charts/outputs/2026-10-23/每周听课汇总-模拟版.xlsx');
fs.mkdirSync(path.dirname(output),{recursive:true});
// Use the actual mini program export path, not a separately drawn workbook.
fs.writeFileSync(output,Buffer.from(exportXlsx(weeklyChartFixture(),8)));
console.log(output);
