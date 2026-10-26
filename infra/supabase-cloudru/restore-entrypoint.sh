#!/bin/sh
set -eu
initdb -D /restore-data/pg --username=supabase_admin --auth-local=trust --auth-host=reject --encoding=UTF8 --locale=C.UTF-8 > /restore-data/init.log 2>&1
exec postgres -D /restore-data/pg -k /tmp -c listen_addresses= -c shared_buffers=128MB -c max_connections=20 -c shared_preload_libraries=pg_stat_statements,pgsodium,supabase_vault,pg_net -c wal_level=logical
