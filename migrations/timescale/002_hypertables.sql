SELECT create_hypertable('metrics', 'at', if_not_exists => TRUE);
SELECT create_hypertable('alerts', 'at', if_not_exists => TRUE);

