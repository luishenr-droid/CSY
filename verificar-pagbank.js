'use strict';

const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

const checks = [
  [source.includes("'https://sandbox.api.pagseguro.com'"), 'Endpoint oficial de sandbox'],
  [source.includes("'https://api.pagseguro.com'"), 'Endpoint oficial de produção'],
  [source.includes("Authorization: `Bearer ${PAGBANK_TOKEN}`"), 'Autenticação Bearer'],
  [source.includes("pagBankRequest('/checkouts'"), 'Criação de Checkout'],
  [source.includes("payment_methods: [{ type: paymentMethod }]"), 'Pix e boleto no Checkout'],
  [source.includes('PAGBANK_WEBHOOK_VERIFICATION'), 'Verificação adaptativa de webhook'],
  [source.includes("'X-Quiz-Version': '6.8.38'"), 'Versão 6.8.38'],
];

const failures = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? 'OK' : 'ERRO'} - ${label}`);
if (failures.length) process.exit(1);

