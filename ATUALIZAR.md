# NZN Quiz 6.8.7

## Arquivos para substituir no GitHub

Substitua somente os arquivos da raiz do repositório:

- `server.js`
- `package.json`

Depois faça o commit.

## Publicar no Render

No Web Service que está funcionando:

1. Abra **Manual Deploy**.
2. Escolha **Clear build cache & deploy**.
3. Aguarde aparecer **Live**.
4. Abra `/health` e confirme `"version":"6.8.7"`.

## O que mudou

### Foto de perfil

Em **Minha conta > Perfil e segurança**, o usuário pode enviar, trocar ou remover sua foto. São aceitos JPG, PNG e WEBP. A imagem é recortada automaticamente em formato quadrado e reduzida antes do envio.

A foto aparece no menu superior, no perfil e na lista de usuários do ADM Master.

### Ciclo de inatividade dos instrutores

- Do dia 0 ao 29: perfil ativo.
- No dia 30: perfil fica inativo automaticamente.
- Do dia 30 ao 39: o próprio instrutor consegue reativar o perfil fazendo login com a senha correta.
- Do dia 40 ao 44: somente o ADM Master consegue reativar.
- No dia 45: o perfil do instrutor é excluído automaticamente.
- Quando o ADM Master reativa o perfil, todos os prazos recomeçam do zero.
- Contas ADM Master não entram nessa regra.

Somente o ADM Master vê, no painel de usuários, as datas de inativação, restrição ao Master e exclusão, além dos dias restantes.

### Correção do botão Iniciar

Ao clicar em **Iniciar**, a preparação da sala agora aparece na própria área de Quizzes. Depois de informar os prêmios, clique em **Criar sala e abrir apresentação**.

## PostgreSQL

A foto de perfil, os usuários e os prazos precisam do PostgreSQL conectado pela variável `DATABASE_URL` para permanecerem salvos após reinicializações do Render.

A atualização cria automaticamente as novas colunas necessárias no banco existente.
