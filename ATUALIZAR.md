# NZN Quiz 6.8.33 — PagBank (Pix e boleto)

Esta revisão mantém a versão 6.8.33 e altera somente o módulo Apoie o NZN.

## Alterações

- removidas as opções Cartão de crédito e Cartão de débito;
- permanecem Pix e boleto;
- protocolos, histórico, webhook e módulo Apoios recebidos foram mantidos;
- transações antigas continuam preservadas no banco;
- nenhuma outra função do NZN foi alterada.

## Atualização

Substitua `server.js` e `package.json` no GitHub. Depois faça `Manual Deploy → Clear build cache & deploy` no Render.

O `/health` continuará mostrando `6.8.33`.
