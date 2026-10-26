from django.urls import path

from .views import LiveTokenApi

urlpatterns = [path("token/", LiveTokenApi.as_view())]
