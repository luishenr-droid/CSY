# Atualizar o projeto existente

## GitHub

1. Extraia o ZIP.
2. Abra seu repositório do quiz.
3. Clique em **Add file > Upload files**.
4. Arraste `server.js` e `package.json`.
5. O GitHub avisará que os arquivos serão substituídos.
6. Escreva no commit: `Atualizar layout e recursos do quiz`.
7. Clique em **Commit changes**.

## Render

O Render deve iniciar um deploy automaticamente.

Caso não inicie:

1. Abra o Web Service.
2. Clique em **Manual Deploy**.
3. Selecione **Clear build cache & deploy**.
4. Aguarde o status **Live**.
5. Atualize o site usando `Ctrl + F5`.

## Não altere

- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: vazio
- Health Check: `/health`
