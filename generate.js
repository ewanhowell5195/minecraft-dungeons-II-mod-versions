import fs from "node:fs"
import zlib from "node:zlib"

const API = "https://api.nexusmods.com/v2/graphql"
const GAME_ID = "10391"
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz .-_;=\n'()+!,&[]:/#@~*%^$"
const END = 63
const SIZE = 256
const CELL = 2
const CELLS = SIZE / CELL
const LEVELS = [0, 85, 170, 255]
const BATCH = 40

async function query(text) {
  const response = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: text }) })
  if (!response.ok) throw new Error(`Nexus Mods returned ${response.status}`)
  const json = await response.json()
  if (json.errors) throw new Error(JSON.stringify(json.errors))
  return json.data
}

async function modIds() {
  const ids = []
  let offset = 0
  while (true) {
    const data = await query(`{ mods(filter: { gameId: [{ value: "${GAME_ID}", op: EQUALS }] }, count: 100, offset: ${offset}) { totalCount nodes { modId } } }`)
    ids.push(...data.mods.nodes.map(node => node.modId))
    offset += data.mods.nodes.length
    if (!data.mods.nodes.length || offset >= data.mods.totalCount) return ids.sort((a, b) => a - b)
  }
}

async function modFiles(ids) {
  const files = {}
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH)
    const data = await query(`{ ${batch.map(id => `m${id}: modFiles(modId: ${id}, gameId: ${GAME_ID}) { name version category date }`).join(" ")} }`)
    for (const id of batch) files[id] = data[`m${id}`] ?? []
  }
  return files
}

function clean(value) {
  return Array.from(String(value ?? "").toLowerCase().replace(/[;=\n]/g, " ").trim()).map(char => ALPHABET.includes(char) ? char : "_").join("")
}

function line(id, files) {
  const current = files.filter(file => file.category !== "ARCHIVED").sort((a, b) => a.date - b.date)
  const main = current.filter(file => file.category === "MAIN").at(-1)
  const named = new Map()
  for (const file of current) named.set(clean(file.name), clean(file.version))
  return [String(id), main ? clean(main.version) : ""].concat(Array.from(named, ([name, version]) => `${name}=${version}`)).join(";")
}

function crc32(bytes) {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length)
  head.write(type, 4, "ascii")
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, tail])
}

function png(cells) {
  const rows = []
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 3)
    for (let x = 0; x < SIZE; x++) {
      const value = cells[Math.floor(y / CELL) * CELLS + Math.floor(x / CELL)]
      row[1 + x * 3] = value[0]
      row[2 + x * 3] = value[1]
      row[3 + x * 3] = value[2]
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}

function encode(text) {
  const values = Array.from(text).map(char => ALPHABET.indexOf(char)).concat(END)
  if (values.length + LEVELS.length > CELLS * CELLS) throw new Error(`${values.length} characters do not fit`)
  const cells = LEVELS.map(level => [level, level, level])
  for (const value of values) cells.push([LEVELS[value >> 4], LEVELS[(value >> 2) & 3], LEVELS[value & 3]])
  while (cells.length < CELLS * CELLS) cells.push([0, 0, 0])
  return png(cells)
}

const ids = await modIds()
const files = await modFiles(ids)
const text = ids.map(id => line(id, files[id])).join("\n")
await fs.promises.writeFile("versions.png", encode(text))
await fs.promises.writeFile("versions.txt", text)
await fs.promises.writeFile("timestamp.txt", new Date().toISOString().slice(0, 10))
console.log(`${ids.length} mods, ${text.length} characters`)
