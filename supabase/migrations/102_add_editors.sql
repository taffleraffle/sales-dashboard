-- Add new editors: Temujin, Youssef, Macan, Enzo
INSERT INTO public.lib_creative_editors (name, slug, email) VALUES
  ('Temujin', 'temujin', 'temujin.andrex@gmail.com'),
  ('Youssef',  'youssef', 'contact.youssef.design@gmail.com'),
  ('Macan',    'macan',   's.makan1384@gmail.com'),
  ('Enzo',     'enzo',    'zonevfx43@gmail.com')
ON CONFLICT (slug) DO UPDATE SET
  email  = EXCLUDED.email,
  active = TRUE;
