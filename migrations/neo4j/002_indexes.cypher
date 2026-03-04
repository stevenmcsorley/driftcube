CREATE INDEX symbol_name IF NOT EXISTS
FOR (s:Symbol) ON (s.name);

CREATE INDEX file_language IF NOT EXISTS
FOR (f:File) ON (f.language);

CREATE INDEX commit_time IF NOT EXISTS
FOR (c:Commit) ON (c.timestamp);

