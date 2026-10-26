CREATE UNIQUE INDEX unique_machine_serial ON machines(tenant_id,serial_number) WHERE serial_number<>'';
