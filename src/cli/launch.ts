/**
 * `npm start` 的分发口。
 *
 * 默认开网页设置页;`npm start -- --cli` 回落到终端向导。
 * 终端那条路必须留着 —— SSH、没有图形界面的机器、以及习惯问题。
 */

export {};

const useCli = process.argv.slice(2).some(a => a === '--cli' || a === '--no-ui');
await import(useCli ? './start.js' : './setupUi.js');
