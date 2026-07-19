-- ============================================================
-- Дурак Online — настройка базы данных Supabase
-- ============================================================
-- Как использовать:
-- 1. Откройте ваш проект на supabase.com
-- 2. Слева в меню откройте "SQL Editor"
-- 3. Вставьте весь этот файл целиком и нажмите "Run"
-- ============================================================

-- Таблица комнат/партий. Каждая строка — одна игра между двумя людьми.
-- Всё состояние игры (карты, чей ход и т.д.) хранится в одном JSON-поле state.
-- Это самый простой надёжный вариант для казуальной игры на двоих.
create table if not exists public.durak_games (
  code text primary key,                 -- код комнаты, например "AB3XQ9"
  state jsonb not null,                  -- полное состояние игры в формате JSON
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Автоматически обновляем updated_at при каждом изменении строки
create or replace function public.durak_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists durak_games_touch on public.durak_games;
create trigger durak_games_touch
  before update on public.durak_games
  for each row
  execute function public.durak_touch_updated_at();

-- Включаем Row Level Security
alter table public.durak_games enable row level security;

-- Политики доступа: это казуальная игра между друзьями по коду комнаты,
-- поэтому любой, у кого есть anon-ключ (то есть любой посетитель сайта),
-- может читать и писать в любую строку. Защиты "по паролю" здесь нет —
-- код комнаты и есть ваш "пароль". Не используйте это для конфиденциальных данных.
drop policy if exists "Anyone can read games" on public.durak_games;
create policy "Anyone can read games"
  on public.durak_games for select
  using (true);

drop policy if exists "Anyone can create games" on public.durak_games;
create policy "Anyone can create games"
  on public.durak_games for insert
  with check (true);

drop policy if exists "Anyone can update games" on public.durak_games;
create policy "Anyone can update games"
  on public.durak_games for update
  using (true);

-- Не даём случайно удалять партии из клиента
drop policy if exists "No deletes" on public.durak_games;

-- Включаем Realtime для этой таблицы, чтобы оба игрока
-- мгновенно получали изменения состояния игры
alter publication supabase_realtime add table public.durak_games;

-- (Необязательно) Периодическая очистка старых партий, чтобы база не росла бесконечно.
-- Если хотите, можно вручную выполнять раз в какое-то время:
-- delete from public.durak_games where updated_at < now() - interval '2 days';
