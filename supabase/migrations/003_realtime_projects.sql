-- Add projects table to Supabase Realtime so the dashboard project list updates live during scanning
alter publication supabase_realtime add table projects;
