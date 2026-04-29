<?php
// wp-content/db.php 로 배치됨
class wpdb_d1 extends wpdb {
    public function query($query) {
        $translated = JS::call("SQLRelay.translate", $query);
        return parent::query($translated);
    }
}
$wpdb = new wpdb_d1(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
