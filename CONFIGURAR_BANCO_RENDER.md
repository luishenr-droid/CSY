# Salvar administradores e quizzes permanentemente

O projeto funciona sem banco, mas o Render gratuito possui sistema de arquivos temporário. Para preservar novos administradores, quizzes e resultados, configure PostgreSQL.

## Criar o banco

1. No Render, clique em **+ New**.
2. Escolha **Postgres**.
3. Nome: `quiz-credsystem-db`.
4. Escolha a mesma região do Web Service.
5. Para testes, selecione **Free**.
6. Clique em **Create Database**.

## Conectar ao site

1. Abra o banco criado.
2. Copie a **Internal Database URL**.
3. Abra o Web Service do quiz.
4. Entre em **Environment**.
5. Adicione:

   `DATABASE_URL` = endereço copiado

6. Clique em **Save, rebuild, and deploy**.
7. Aguarde aparecer **Live**.
8. Entre no painel. Deve aparecer a mensagem **Banco de dados conectado**.

## Atenção

O PostgreSQL gratuito do Render é indicado apenas para testes e expira após 30 dias. Para uso contínuo em treinamentos corporativos, use um banco pago ou outro PostgreSQL permanente.
