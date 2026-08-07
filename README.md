# NZN — Simulador de Carga v1

Ferramenta separada para simular até 500 participantes na sua própria plataforma NZN.

## O que ele faz

1. Cria participantes virtuais `Teste 001`, `Teste 002` etc.
2. Abre uma conexão em tempo real para cada participante.
3. Marca todos como prontos.
4. Aguarda você iniciar o quiz normalmente como apresentador.
5. Responde automaticamente às perguntas com pequenos intervalos aleatórios.
6. Mostra latência de entrada e resposta, erros e quantidade de conexões.

## Publicar no Render

Crie um NOVO repositório GitHub apenas para este simulador e envie:

- server.js
- package.json
- render.yaml

No Render, crie um novo Web Service ou Blueprint.

Configure duas variáveis de ambiente:

### TARGET_URL
Endereço da sua plataforma NZN, sem barra final.

Exemplo:
`https://seu-nzn.onrender.com`

### SIMULATOR_PASSWORD
Crie uma senha exclusiva para impedir que outras pessoas iniciem testes.

Nunca use a mesma senha do ADM Master.

## Como testar

1. Atualize o NZN para a versão 6.8.25.
2. No NZN, crie ou abra um quiz de teste.
3. Inicie uma sala, mas NÃO inicie as perguntas ainda.
4. Abra o site do simulador.
5. Informe o código da sala.
6. Comece com 50 participantes.
7. Aguarde o simulador informar que todos estão prontos.
8. No apresentador NZN, clique em Iniciar quiz.
9. Os participantes virtuais responderão automaticamente.
10. Repita com 100, 250 e 500 participantes.

## Sequência recomendada

- 50 pessoas — validação básica
- 100 pessoas — comparação com o limite anterior
- 250 pessoas — teste intermediário
- 500 pessoas — teste de capacidade

Faça apenas um teste por vez inicialmente.

## O que observar no Render do NZN

Durante o teste, abra Metrics e acompanhe:

- CPU
- Memory
- reinicializações
- erros 5xx
- tempo de resposta

Se o serviço reiniciar ou ficar muito lento em 500, o código aceita 500, mas o plano do Render pode precisar de mais capacidade.

## Segurança

O simulador foi feito para testar somente a sua própria plataforma. `TARGET_URL` fica fixado no Render e o início do teste exige `SIMULATOR_PASSWORD`.
