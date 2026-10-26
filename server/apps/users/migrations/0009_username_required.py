from django.db import migrations, models


class Migration(migrations.Migration):
    """After 0008 gave everyone a username: required and unique from now on."""

    dependencies = [("users", "0008_username")]

    operations = [
        migrations.AlterField(model_name="user", name="username", field=models.CharField(max_length=20, unique=True)),
    ]
