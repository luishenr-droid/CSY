# Criar o GitHub do zero

## Opcao recomendada: Git pelo terminal

### 1. Extraia o backup

Extraia o arquivo ZIP e abra a pasta `NZN-Quiz-6.8.38-PagBank`.

### 2. Crie um repositorio vazio

No GitHub:

1. Clique em **New repository**.
2. Use um nome como `nzn-quiz`.
3. Escolha **Private** enquanto estiver configurando.
4. Nao marque README, `.gitignore` ou licenca, pois esses arquivos ja estao no pacote.
5. Clique em **Create repository**.
6. Copie a URL HTTPS exibida pelo GitHub.

### 3. Envie os arquivos

Abra o Terminal, PowerShell ou Git Bash dentro da pasta extraida e execute:

```bash
git init
git add .
git commit -m "Publicar NZN Quiz 6.8.38"
git branch -M main
git remote add origin COLE_AQUI_A_URL_DO_GITHUB
git push -u origin main
```

Exemplo de URL:

```text
https://github.com/SEU-USUARIO/nzn-quiz.git
```

## Opcao visual: GitHub Desktop

1. Abra o GitHub Desktop.
2. Escolha **Add an Existing Repository from your Hard Drive**.
3. Selecione a pasta extraida.
4. Caso seja solicitado, escolha **Create a Repository** nessa pasta.
5. Confirme o primeiro commit.
6. Clique em **Publish repository** e mantenha o repositorio privado durante a configuracao.

## Depois do GitHub

1. Acesse o Render.
2. Clique em **New > Blueprint**.
3. Conecte o repositorio criado.
4. Informe o e-mail, usuario e senha do primeiro ADM Master.
5. Confirme o deploy.
6. Verifique `/health`; a versao deve ser `6.8.38`.

## Seguranca

- Nao coloque senhas ou tokens no `server.js`, `render.yaml` ou README.
- Nao renomeie `.env.example` para `.env` antes de enviar sem conferir se o `.gitignore` esta ativo.
- Configure Resend e PagBank apenas na area de variaveis do Render.
- Para o teste PagBank, use `PAGBANK_ENV=sandbox` e `PAGBANK_WEBHOOK_VERIFICATION=auto`.
- Troque a senha inicial do administrador depois do primeiro acesso.
