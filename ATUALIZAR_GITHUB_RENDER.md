# Atualização 6.2 — celular, contagem regressiva e confirmação de pronto

## Arquivos que devem substituir os atuais no GitHub

- `server.js`
- `package.json`

O `server.js` já contém a interface completa incorporada. Não é obrigatório enviar a pasta `public` para o Render, embora ela esteja incluída no pacote como código-fonte.

## Passos

1. Abra o repositório do servidor correto no GitHub.
2. Clique em **Add file → Upload files**.
3. Envie `server.js` e `package.json` desta pasta.
4. Confirme a substituição dos arquivos antigos.
5. Use a mensagem de commit: `Atualizar quiz para versão 6.2`.
6. No Render, abra o Web Service correto.
7. Aguarde o Auto-Deploy ou use **Manual Deploy → Clear build cache & deploy**.
8. Aguarde aparecer **Live**.
9. Abra `/health` no final do endereço. Deve mostrar `"version":"6.2.0"`.
10. Atualize o site com `Ctrl + F5` ou teste em uma janela anônima.

## Novo funcionamento

- Cada participante entra como **Aguardando**.
- No celular, ele precisa clicar em **Marcar como pronto**.
- O apresentador acompanha o contador de prontos.
- O botão **Iniciar quiz** só é liberado quando todos estiverem prontos.
- Ao iniciar, todos veem uma contagem regressiva 3, 2, 1.
- Depois da contagem, a primeira pergunta aparece ao mesmo tempo para todos.
