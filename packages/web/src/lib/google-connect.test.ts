/**
 * Testes de `lib/google-connect.ts`.
 *
 * O módulo tem quatro linhas, mas cada uma existe por causa de um vazamento
 * concreto: o caminho antigo era
 * `window.location.href = API + "/auth/google?token=" + jwt`, que punha o JWT
 * de sessão de 24h na barra de endereço — e de lá no histórico do navegador, no
 * `Referer` e no log de acesso de todo intermediário.
 *
 * O que se trava aqui é justamente o que não se vê lendo o código: que a
 * navegação NÃO carrega segredo, e que uma falha não cai de volta no caminho
 * antigo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const googleAuthUrl = vi.fn();

vi.mock('./api-client', () => ({ api: { googleAuthUrl } }));

const { conectarGoogle } = await import('./google-connect');

let janela: { location: { href: string } };

beforeEach(() => {
  vi.clearAllMocks();
  janela = { location: { href: '/apis' } };
  vi.stubGlobal('window', janela);
  vi.stubGlobal(
    'localStorage',
    { getItem: () => 'jwt-de-sessao', setItem: () => {}, removeItem: () => {} },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conectarGoogle', () => {
  it('navega para a URL que a API devolveu', async () => {
    googleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' });

    await conectarGoogle();

    expect(janela.location.href).toBe('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
  });

  it('a URL de destino não carrega o token de sessão', async () => {
    // O teste que dá sentido ao módulo. Antes o destino era a própria API com
    // `?token=<jwt>`; hoje é o Google, e o JWT ficou no header do POST.
    googleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' });

    await conectarGoogle();

    expect(janela.location.href).not.toContain('jwt-de-sessao');
    expect(janela.location.href).not.toContain('token=');
  });

  it('propaga a falha e NÃO cai no caminho antigo', async () => {
    // Um fallback para `/auth/google?token=` reintroduziria exatamente o
    // vazamento que este módulo elimina. Se a API estiver numa versão sem o
    // endpoint novo — a janela entre o deploy do Render e o da Vercel —, o
    // botão tem que falhar e avisar, não vazar calado.
    googleAuthUrl.mockRejectedValue(new Error('404'));

    await expect(conectarGoogle()).rejects.toThrow('404');
    expect(janela.location.href).toBe('/apis'); // não navegou para lugar nenhum
  });

  it('pede a URL à API em vez de montá-la no cliente', async () => {
    // Montar a URL do Google no front exigiria o client_id e os escopos aqui,
    // duplicando o que a API já sabe — e divergindo na primeira mudança.
    googleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/x' });

    await conectarGoogle();

    expect(googleAuthUrl).toHaveBeenCalledTimes(1);
  });
});
