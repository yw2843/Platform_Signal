import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outDir = "outputs/signal_model";
await fs.mkdir(outDir, { recursive: true });
const wb = Workbook.create();
const guide = wb.worksheets.add("Read Me");
const assumptions = wb.worksheets.add("Assumptions");
const model = wb.worksheets.add("Flight Model");

const navy = "#17365D", blue = "#D9EAF7", pale = "#EAF2F8", green = "#E2F0D9", yellow = "#FFF2CC";
for (const s of [guide, assumptions, model]) { s.showGridLines = false; }

guide.getRange("A1:F1").merge();
guide.getRange("A1").values = [["Prototype Flight Communication Signal Model"]];
guide.getRange("A1:F1").format = { fill: navy, font: { bold: true, color: "#FFFFFF", size: 16 }, rowHeight: 30 };
guide.getRange("A3:B10").values = [
  ["Purpose", "Calculate theoretical relative VHF propagation quality for each flight observation."],
  ["1. Assign link", "Use the flight-phase model to assign a service, frequency, and assumed transmitter site."],
  ["2. Horizontal distance", "Calculate great-circle distance between aircraft and transmitter coordinates."],
  ["3. Slant distance", "Combine horizontal distance with aircraft-to-antenna height difference."],
  ["4. Propagation loss", "FSPL = 32.45 + 20 log10(distance km) + 20 log10(frequency MHz)."],
  ["5. Line of sight", "Compare horizontal distance with the approximate radio-horizon distance."],
  ["6. Score", "Normalize FSPL between editable strong and weak loss boundaries, then apply an optional non-LOS penalty."],
  ["Interpretation", "The score is modeled relative quality, not measured received power or actual signal strength in dBm."]
];
guide.getRange("A3:A10").format = { fill: blue, font: { bold: true }, wrapText: true };
guide.getRange("B3:B10").format = { wrapText: true };
guide.getRange("A12:B18").values = [
  ["Required flight field", "Expected unit / meaning"],
  ["flight_id", "Text identifier"], ["timestamp", "Date/time"], ["aircraft_lat", "Decimal degrees"],
  ["aircraft_lon", "Decimal degrees"], ["aircraft_altitude_ft", "Feet above mean sea level"],
  ["frequency_mhz", "Assigned representative VHF frequency"]
];
guide.getRange("A12:B12").format = { fill: navy, font: { bold: true, color: "#FFFFFF" } };
guide.getRange("A1:B18").format.autofitRows();
guide.getRange("A:A").format.columnWidth = 24; guide.getRange("B:B").format.columnWidth = 88;

assumptions.getRange("A1:D1").merge();
assumptions.getRange("A1").values = [["Editable Model Assumptions"]];
assumptions.getRange("A1:D1").format = { fill: navy, font: { bold: true, color: "#FFFFFF", size: 15 }, rowHeight: 28 };
assumptions.getRange("A3:D10").values = [
  ["Parameter", "Value", "Unit", "Purpose"],
  ["Earth radius", 6371, "km", "Great-circle distance calculation"],
  ["Strong-loss boundary", 90, "dB", "FSPL at or below this maps to score 100"],
  ["Weak-loss boundary", 115, "dB", "FSPL at or above this maps to score 0"],
  ["Non-line-of-sight penalty", 20, "points", "Optional prototype penalty when beyond radio horizon"],
  ["Effective Earth horizon factor", 4.12, "km/sqrt(m)", "Approximate radio horizon using 4/3 Earth radius"],
  ["Default transmitter latitude", 40.7769, "degrees", "LGA reference coordinate; replace when a better site is known"],
  ["Default transmitter longitude", -73.8740, "degrees", "LGA reference coordinate; replace when a better site is known"]
];
assumptions.getRange("A3:D3").format = { fill: navy, font: { bold: true, color: "#FFFFFF" } };
assumptions.getRange("B4:B10").format = { fill: yellow, font: { color: "#0070C0" } };
assumptions.getRange("A3:D10").format.borders = { preset: "outside", style: "thin", color: "#A6A6A6" };
assumptions.getRange("A:D").format.autofitColumns(); assumptions.getRange("D:D").format.columnWidth = 58;

const headers = [["flight_id","timestamp","phase","service","frequency_mhz","aircraft_lat","aircraft_lon","aircraft_altitude_ft","transmitter_lat","transmitter_lon","antenna_height_m","horizontal_km","slant_km","fspl_db","radio_horizon_km","line_of_sight","raw_score","final_score","category","model_note"]];
model.getRange("A1:T1").merge(); model.getRange("A1").values = [["Flight Inputs and Calculated Signal Quality"]];
model.getRange("A1:T1").format = { fill: navy, font: { bold: true, color: "#FFFFFF", size: 15 }, rowHeight: 28 };
model.getRange("A3:T3").values = headers;
model.getRange("A3:T3").format = { fill: navy, font: { bold: true, color: "#FFFFFF" }, wrapText: true, rowHeight: 34 };
model.getRange("A4:K4").values = [["EXAMPLE-LGA-ARR","2026-07-16 12:00","approach","approach",125,40.9567,-73.8740,3000,40.7769,-73.8740,50]];
model.getRange("A4:K4").format.fill = yellow;

model.getRange("L4").formulas = [["=IF(A4=\"\",\"\",2*'Assumptions'!$B$4*ASIN(SQRT(SIN(RADIANS(F4-I4)/2)^2+COS(RADIANS(F4))*COS(RADIANS(I4))*SIN(RADIANS(G4-J4)/2)^2)))"]];
model.getRange("M4").formulas = [["=IF(A4=\"\",\"\",SQRT(L4^2+((H4*0.3048-K4)/1000)^2))"]];
model.getRange("N4").formulas = [["=IF(A4=\"\",\"\",32.45+20*LOG10(MAX(M4,0.001))+20*LOG10(E4))"]];
model.getRange("O4").formulas = [["=IF(A4=\"\",\"\",'Assumptions'!$B$8*(SQRT(MAX(H4*0.3048,0))+SQRT(MAX(K4,0))))"]];
model.getRange("P4").formulas = [["=IF(A4=\"\",\"\",IF(L4<=O4,\"Yes\",\"No\"))"]];
model.getRange("Q4").formulas = [["=IF(A4=\"\",\"\",100*('Assumptions'!$B$6-N4)/('Assumptions'!$B$6-'Assumptions'!$B$5))"]];
model.getRange("R4").formulas = [["=IF(A4=\"\",\"\",MAX(0,MIN(100,Q4-IF(P4=\"No\",'Assumptions'!$B$7,0))))"]];
model.getRange("S4").formulas = [["=IF(A4=\"\",\"\",IF(R4>=80,\"Strong\",IF(R4>=50,\"Moderate\",\"Weak\")))"]];
model.getRange("T4").formulas = [["=IF(A4=\"\",\"\",\"Relative prototype score; not measured dBm\")"]];
for (const col of ["L","M","N","O","P","Q","R","S","T"]) model.getRange(`${col}4:${col}203`).fillDown();
model.getRange("L4:R203").format.fill = pale;
model.getRange("L4:O203").format.numberFormat = "0.0"; model.getRange("Q4:R203").format.numberFormat = "0";
model.getRange("A3:T203").format.borders = { preset: "outside", style: "thin", color: "#BFBFBF" };
model.getRange("A3:T203").format.autofitColumns();
for (const c of ["A","B","C","D","S"]) model.getRange(`${c}:${c}`).format.columnWidth = 18;
model.getRange("T:T").format.columnWidth = 38;
model.freezePanes.freezeRows(3);
model.getRange("R4:R203").conditionalFormats.add("colorScale", { colors: ["#F8696B", "#FFEB84", "#63BE7B"], thresholds: ["min", "50%", "max"] });

const check = await wb.inspect({ kind: "table", sheetId: "Flight Model", range: "A3:T6", include: "values,formulas", tableMaxRows: 6, tableMaxCols: 20 });
console.log(check.ndjson);
const errors = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 50 }, summary: "formula scan" });
console.log(errors.ndjson);
for (const s of ["Read Me", "Assumptions", "Flight Model"]) {
  const image = await wb.render({ sheetName: s, autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(`${outDir}/${s.replaceAll(" ", "_")}.png`, new Uint8Array(await image.arrayBuffer()));
}
const xlsx = await SpreadsheetFile.exportXlsx(wb);
await xlsx.save(`${outDir}/flight_signal_quality_model.xlsx`);
